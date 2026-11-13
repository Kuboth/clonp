/**
 * @file server.js
 * @description Servidor clonp - Debrid, Streaming e Downloader para MEGA.nz
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const path = require('path');
const mime = require('mime-types');
const archiver = require('archiver');
const srt2vtt = require('srt-to-vtt');
const axios = require('axios');
const { File } = require('megajs');
const { HttpsProxyAgent } = require('https-proxy-agent');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuração de Proxy confiável (Render / PaaS)
app.set('trust proxy', 1);

// Ativa compressão HTTP Gzip/Deflate para páginas, JSONs e scripts (exclui streams de mídia)
app.use(compression({
  filter: (req, res) => {
    // Não compacta rotas de streaming e downloads binários que já possuem compressão própria
    if (req.path.startsWith('/api/stream') || req.path.startsWith('/api/download-batch')) {
      return false;
    }
    return compression.filter(req, res);
  },
  level: 6,
  threshold: 1024 // Compacta apenas respostas maiores que 1KB
}));

// Middleware manual de CORS e cabeçalhos de mídia permissivos para Canvas/Video
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Accept');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges, Content-Disposition');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// 1. Cabeçalhos de Segurança HTTP (Helmet com liberação para mídia e CDN)
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: false,
    crossOriginEmbedderPolicy: false
  })
);

app.use(cors());
app.use(express.json({ limit: '200kb' })); // Limita payload de JSON contra ataques de overflow
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1d',
  etag: true,
  lastModified: true
}));

// 2. Rate Limiting (Proteção contra DoS / Abuso)
const inspectLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100, // Limite de 100 inspeções por IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições. Aguarde alguns minutos antes de tentar novamente.' }
});

const streamLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 3000, // Alto limite para acomodar requisições de miniaturas e múltiplos chunks de streaming
  standardHeaders: true,
  legacyHeaders: false
});

/**
 * @typedef {Object} CachedFileItem
 * @property {any} instance Instância megajs.File
 * @property {number} cachedAt Timestamp em milissegundos
 */

/**
 * @typedef {Object} TreeNode
 * @property {string} id ID do nó
 * @property {string} name Nome do arquivo ou pasta
 * @property {boolean} isDirectory Se é pasta
 * @property {number} size Tamanho em bytes
 * @property {string} formattedSize Tamanho legível
 * @property {string} path Caminho relativo
 * @property {string} mimeType Tipo MIME
 * @property {string} extension Extensão em minúsculas
 * @property {number} timestamp Timestamp de modificação
 * @property {string} formattedDate Data formatada em pt-BR
 * @property {string} [subtitleId] ID de legenda associada
 * @property {TreeNode[]} children Filhos caso seja diretório
 */

/**
 * @typedef {Object} CachedFolder
 * @property {string} name Nome da pasta raiz
 * @property {TreeNode[]} items Lista plana de arquivos
 * @property {number} cachedAt Timestamp
 */

// 3. Cache em memória com TTL (Auto-limpeza para evitar estouro de RAM no Render)
const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 horas de vida útil
/** @type {Map<string, CachedFileItem>} */
const fileInstancesCache = new Map();
/** @type {Map<string, CachedFolder>} */
const folderCache = new Map();
/** @type {Map<string, { ids: string[], zipName: string, expiresAt: number }>} */
const batchTokenCache = new Map();

// Rotina periódica a cada 15 minutos para remover itens expirados
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of fileInstancesCache.entries()) {
    if (now - val.cachedAt > CACHE_TTL_MS) {
      fileInstancesCache.delete(key);
    }
  }
  for (const [key, val] of folderCache.entries()) {
    if (now - val.cachedAt > CACHE_TTL_MS) {
      folderCache.delete(key);
    }
  }
  for (const [key, val] of batchTokenCache.entries()) {
    if (now > val.expiresAt) {
      batchTokenCache.delete(key);
    }
  }
}, 15 * 60 * 1000);

// ============================================================================
// SISTEMA SMARTPROXY HÍBRIDO (Direto por padrão + Failover Inteligente no erro 509)
// ============================================================================
let proxyPool = [];
let proxyPointer = 0;
/** @type {Map<string, number>} */
const cooldownProxies = new Map();

/**
 * Carrega a lista de proxies estruturados a partir da variável de ambiente CUSTOM_PROXIES
 * Formatos suportados:
 * - host:port
 * - user:pass@host:port
 * - http://user:pass@host:port
 * - Separados por vírgula, ponto-e-vírgula ou quebra de linha
 */
function loadProxyPool() {
  const rawList = process.env.CUSTOM_PROXIES || '';
  if (!rawList) {
    proxyPool = [];
    return proxyPool;
  }

  const collected = rawList
    .split(/[,;\n]/)
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => {
      if (!p.startsWith('http://') && !p.startsWith('https://') && !p.startsWith('socks5://')) {
        return `http://${p}`;
      }
      return p;
    });

  proxyPool = Array.from(new Set(collected));
  console.log(`[SmartProxy] Pool inicializado com ${proxyPool.length} proxy(ies) de alta velocidade.`);
  return proxyPool;
}

loadProxyPool();

/**
 * Retorna o próximo proxy disponível que não esteja em período de cooldown
 * @returns {string | null}
 */
function getNextAvailableProxy() {
  if (proxyPool.length === 0) return null;

  const now = Date.now();
  const total = proxyPool.length;

  for (let i = 0; i < total; i++) {
    const candidate = proxyPool[(proxyPointer + i) % total];
    const cooldownUntil = cooldownProxies.get(candidate);
    if (!cooldownUntil || now > cooldownUntil) {
      proxyPointer = (proxyPointer + i + 1) % total;
      return candidate;
    }
  }
  // Se todos estiverem em cooldown, usa o próximo ciclicamente
  const fallback = proxyPool[proxyPointer % total];
  proxyPointer = (proxyPointer + 1) % total;
  return fallback;
}

/**
 * Cria uma instância HttpsProxyAgent com suporte a autenticação
 * @param {string | null} proxyUrl 
 * @returns {HttpsProxyAgent<string> | null}
 */
function createAgent(proxyUrl) {
  if (!proxyUrl) return null;
  try {
    return new HttpsProxyAgent(proxyUrl);
  } catch (err) {
    console.warn('[SmartProxy] Falha ao instanciar agente proxy:', err.message);
    return null;
  }
}

/**
 * Marca um proxy em cooldown após atingir cota
 * @param {string} proxyUrl 
 * @param {number} [cooldownSeconds=1800] 30 minutos
 */
function markProxyCooldown(proxyUrl, cooldownSeconds = 1800) {
  if (!proxyUrl) return;
  cooldownProxies.set(proxyUrl, Date.now() + cooldownSeconds * 1000);
  console.log(`[SmartProxy] Proxy ${proxyUrl.replace(/:[^:@]+@/, ':***@')} entrou em cooldown por ${cooldownSeconds}s.`);
}

/**
 * Cria uma instância File da biblioteca megajs
 * Conexão direta por padrão (ultra rápida e sem delay)
 * @param {string} url URL pública do MEGA
 * @returns {any}
 */
function createMegaFileInstance(url) {
  return File.fromURL(url);
}

/**
 * Gera um token imutável e autossuficiente contendo a chave e ID do arquivo.
 * Permite que downloads ativos continuem ou sejam retomados mesmo após o reinício do servidor (zero downtime).
 * @param {any} node 
 * @returns {string}
 */
function createStatelessFileId(node) {
  try {
    const meta = {
      d: node.downloadId,
      k: node.key ? node.key.toString('base64') : null,
      n: node.name,
      s: node.size
    };
    return Buffer.from(JSON.stringify(meta)).toString('base64url');
  } catch (err) {
    return `${node.downloadId || node.nodeId || Math.random().toString(36).substring(7)}`;
  }
}

/**
 * Reconstrói transparentemente uma instância megajs.File a partir de um token autossuficiente
 * @param {string} token 
 * @returns {any | null}
 */
function resolveStatelessFile(token) {
  try {
    const decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    if (decoded && decoded.d && decoded.k) {
      const file = new File({
        downloadId: decoded.d,
        key: Buffer.from(decoded.k, 'base64')
      });
      file.name = decoded.n || 'arquivo';
      file.size = decoded.s || 0;
      return file;
    }
  } catch (err) {}
  return null;
}
function safeDownload(file, options = {}, cb) {
  // Configuração Ultra Inteligente: 6 conexões concorrentes, partida ágil em 256KB escalando dinamicamente até 3MB
  const speedOpts = {
    maxConnections: 6,
    initialChunkSize: 256 * 1024,
    chunkSizeIncrement: 512 * 1024,
    maxChunkSize: 3 * 1024 * 1024,
    ...options
  };

  return file.download(speedOpts, cb);
}

/**
 * Formata bytes em formato legível (KB, MB, GB, etc.)
 * @param {number} bytes 
 * @param {number} [decimals=2] 
 * @returns {string}
 */
function formatBytes(bytes, decimals = 2) {
  if (!+bytes) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

/**
 * Sanitização de nomes de arquivos para evitar quebra de cabeçalho HTTP
 * @param {string} name 
 * @returns {string}
 */
function sanitizeFilename(name) {
  return (name || 'download').replace(/[\r\n\t"']/g, '_');
}

// 1. Rota de inspeção do link (Protegida por Rate Limit)
app.post('/api/inspect', inspectLimiter, async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string' || !url.includes('mega.nz')) {
    return res.status(400).json({ error: 'URL do MEGA inválida. Certifique-se de que contenha a chave (#chave).' });
  }

  try {
    const fileOrFolder = createMegaFileInstance(url);
    await fileOrFolder.loadAttributes();

    const now = Date.now();

    if (fileOrFolder.directory) {
      const folderKey = `folder_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      /** @type {TreeNode[]} */
      const allFiles = [];

      const buildTree = (node, currentPath = '') => {
        const nodeId = createStatelessFileId(node);
        fileInstancesCache.set(nodeId, { instance: node, cachedAt: now });

        const timestamp = node.timestamp ? node.timestamp * 1000 : (node.mtime ? new Date(node.mtime).getTime() : Date.now());
        const ext = node.directory ? 'folder' : (node.name.split('.').pop() || '').toLowerCase();

        /** @type {TreeNode} */
        const nodeData = {
          id: nodeId,
          name: node.name || 'Pasta',
          isDirectory: !!node.directory,
          size: node.size || 0,
          formattedSize: formatBytes(node.size || 0),
          path: currentPath ? `${currentPath}/${node.name}` : (node.name || ''),
          mimeType: node.directory ? 'directory' : (mime.lookup(node.name) || 'application/octet-stream'),
          extension: ext,
          timestamp: timestamp,
          formattedDate: new Date(timestamp).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
          children: []
        };

        if (!node.directory) {
          allFiles.push(nodeData);
        } else if (node.children && Array.isArray(node.children)) {
          for (const child of node.children) {
            const childData = buildTree(child, nodeData.path);
            nodeData.children.push(childData);
          }
        }

        return nodeData;
      };

      const rootTree = buildTree(fileOrFolder, '');

      // Parear legendas .srt/.vtt com vídeos
      const subtitles = allFiles.filter(it => it.name.endsWith('.srt') || it.name.endsWith('.vtt'));
      for (const item of allFiles) {
        const ext = item.name.split('.').pop().toLowerCase();
        if (['mp4', 'mkv', 'webm'].includes(ext)) {
          const baseName = item.name.substring(0, item.name.lastIndexOf('.'));
          const matchingSub = subtitles.find(s => s.name.startsWith(baseName));
          if (matchingSub) {
            item.subtitleId = matchingSub.id;
          }
        }
      }

      folderCache.set(folderKey, { name: fileOrFolder.name || 'pasta', items: allFiles, cachedAt: now });

      return res.json({
        type: 'folder',
        folderKey,
        name: fileOrFolder.name || 'Pasta Compartilhada',
        totalFiles: allFiles.length,
        tree: rootTree
      });
    } else {
      const cacheKey = createStatelessFileId(fileOrFolder);
      fileInstancesCache.set(cacheKey, { instance: fileOrFolder, cachedAt: now });

      const timestamp = fileOrFolder.timestamp ? fileOrFolder.timestamp * 1000 : Date.now();
      const ext = (fileOrFolder.name.split('.').pop() || '').toLowerCase();

      /** @type {TreeNode} */
      const singleFile = {
        id: cacheKey,
        name: fileOrFolder.name,
        size: fileOrFolder.size || 0,
        formattedSize: formatBytes(fileOrFolder.size || 0),
        isDirectory: false,
        path: fileOrFolder.name,
        mimeType: mime.lookup(fileOrFolder.name) || 'application/octet-stream',
        extension: ext,
        timestamp: timestamp,
        formattedDate: new Date(timestamp).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
        children: []
      };

      return res.json({
        type: 'file',
        name: fileOrFolder.name,
        totalFiles: 1,
        tree: {
          id: 'root',
          name: fileOrFolder.name,
          isDirectory: true,
          children: [singleFile]
        }
      });
    }
  } catch (err) {
    console.error('Erro ao inspecionar link MEGA:', err);
    return res.status(500).json({
      error: 'Não foi possível ler o link. Verifique se o link está ativo e com a chave completa (#chave).'
    });
  }
});

// 2. Rota de streaming e download individual
app.get('/api/stream/:id', streamLimiter, async (req, res) => {
  const { id } = req.params;
  const isDownload = req.query.download === '1';

  let file = null;
  const cached = fileInstancesCache.get(id);
  if (cached && cached.instance) {
    cached.cachedAt = Date.now();
    file = cached.instance;
  } else {
    // Reconstituição transparente pós-deploy (Stateless Resume)
    file = resolveStatelessFile(id);
    if (file) {
      fileInstancesCache.set(id, { instance: file, cachedAt: Date.now() });
    }
  }

  if (!file) {
    return res.status(404).json({ error: 'Arquivo expirado ou não encontrado no cache. Inspecione o link novamente.' });
  }

  try {
    const filename = sanitizeFilename(file.name);
    const mimeType = mime.lookup(filename) || 'application/octet-stream';
    const fileSize = file.size;

    const headers = {
      'Content-Type': mimeType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800'
    };

    if (isDownload) {
      const asciiFilename = filename.replace(/[^\x20-\x7E]/g, '_');
      headers['Content-Disposition'] = `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
      headers['Content-Type'] = 'application/octet-stream';
    } else {
      headers['Content-Disposition'] = `inline; filename="${encodeURIComponent(filename)}"`;
    }

    const range = req.headers.range;
    if (range && fileSize) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = (end - start) + 1;

      headers['Content-Range'] = `bytes ${start}-${end}/${fileSize}`;
      headers['Content-Length'] = chunkSize;

      // Para requisições pequenas (frames de vídeo, miniaturas, headers), entrega com callback confiável
      if (chunkSize <= 2 * 1024 * 1024) {
        return safeDownload(file, { start, end }, (err, buf) => {
          if (err) {
            console.error('Buffer error (range):', err);
            if (!res.headersSent) res.status(500).json({ error: 'Erro no buffer range: ' + (err.message || err) });
            return;
          }
          res.writeHead(206, headers);
          res.end(buf);
        });
      }

      res.writeHead(206, headers);
      const downloadStream = safeDownload(file, { start, end });
      
      req.on('close', () => {
        if (downloadStream && typeof downloadStream.destroy === 'function') {
          downloadStream.destroy();
        }
      });

      downloadStream.on('error', (err) => {
        console.error('Stream range error:', err);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Stream error: ' + (err.message || err) });
        } else {
          res.end();
        }
      });

      return downloadStream.pipe(res);
    }

    if (fileSize) {
      headers['Content-Length'] = fileSize;
    }

    // Para arquivos pequenos (< 8MB) em preview, entrega tudo em 1 único bloco com buffer
    if (fileSize && fileSize <= 8 * 1024 * 1024 && !isDownload) {
      return safeDownload(file, {}, (err, buf) => {
        if (err) {
          console.error('Buffer download error:', err);
          if (!res.headersSent) res.status(500).json({ error: 'Erro no buffer download: ' + (err.message || err) });
          return;
        }
        res.writeHead(200, headers);
        res.end(buf);
      });
    }

    // Para download ou streaming contínuo:
    res.writeHead(200, headers);
    const downloadStream = safeDownload(file);

    req.on('close', () => {
      if (downloadStream && typeof downloadStream.destroy === 'function') {
        downloadStream.destroy();
      }
    });

    downloadStream.on('error', (err) => {
      console.error('Download stream error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Falha no download: ' + (err.message || err) });
      } else {
        res.end();
      }
    });

    downloadStream.pipe(res);

  } catch (err) {
    console.error('Erro no stream:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Falha no download/stream: ' + (err.message || err) });
    }
  }
});

// 3. Rota de conversão e streaming de legenda para WebVTT
app.get('/api/subtitles/:id', streamLimiter, (req, res) => {
  const { id } = req.params;
  const cached = fileInstancesCache.get(id);

  if (!cached || !cached.instance) {
    return res.status(404).send('Legenda não encontrada.');
  }

  res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
  const stream = safeDownload(cached.instance);

  if (cached.instance.name.endsWith('.srt')) {
    stream.pipe(srt2vtt()).pipe(res);
  } else {
    stream.pipe(res);
  }
});

// 4. Rota de download completo da pasta (.ZIP) em tempo real
app.get('/api/download-folder/:folderKey', streamLimiter, async (req, res) => {
  const { folderKey } = req.params;
  const folderData = folderCache.get(folderKey);

  if (!folderData) {
    return res.status(404).send('Pasta não encontrada ou sessão expirada. Por favor, inspecione o link novamente.');
  }

  const archive = archiver('zip', {
    zlib: { level: 0 }
  });

  const zipName = `${sanitizeFilename(folderData.name || 'mega_folder')}.zip`;
  res.attachment(zipName);

  archive.pipe(res);

  archive.on('error', (err) => {
    console.error('Erro no zip stream:', err);
    if (!res.headersSent) res.status(500).end();
  });

  try {
    for (const item of folderData.items) {
      if (!item.isDirectory) {
        const cached = fileInstancesCache.get(item.id);
        if (cached && cached.instance) {
          const fileStream = safeDownload(cached.instance);
          archive.append(fileStream, { name: item.path });
        }
      }
    }
    await archive.finalize();
  } catch (err) {
    console.error('Erro ao empacotar pasta:', err);
  }
});

// 5. Preparar download em lote (Gera ticket temporário para download via GET sem estourar RAM do navegador)
app.post('/api/download-batch/prepare', streamLimiter, (req, res) => {
  const { ids, zipName } = req.body;
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'Nenhum arquivo selecionado.' });
  }

  const token = `batch_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  batchTokenCache.set(token, {
    ids,
    zipName: sanitizeFilename(zipName || 'clonp_selecao'),
    expiresAt: Date.now() + 10 * 60 * 1000 // 10 minutos
  });

  return res.json({ downloadUrl: `/api/download-batch/${token}` });
});

// 6. Rota GET de streaming do download em lote preparado
app.get('/api/download-batch/:token', streamLimiter, async (req, res) => {
  const { token } = req.params;
  const batchData = batchTokenCache.get(token);

  if (!batchData) {
    return res.status(404).send('Token de download expirado ou não encontrado.');
  }

  const archive = archiver('zip', { zlib: { level: 0 } });
  const finalName = `${batchData.zipName}.zip`;
  res.attachment(finalName);

  archive.pipe(res);
  archive.on('error', (err) => {
    console.error('Erro no batch zip:', err);
    if (!res.headersSent) res.status(500).end();
  });

  try {
    for (const id of batchData.ids) {
      const cached = fileInstancesCache.get(id);
      if (cached && cached.instance) {
        const fileStream = safeDownload(cached.instance);
        archive.append(fileStream, { name: cached.instance.name || 'arquivo' });
      }
    }
    await archive.finalize();
  } catch (err) {
    console.error('Erro ao empacotar seleção:', err);
  }
});

// Rota POST legada mantida para retrocompatibilidade
app.post('/api/download-batch', streamLimiter, async (req, res) => {
  const { ids, zipName } = req.body;
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'Nenhum arquivo selecionado.' });
  }

  const archive = archiver('zip', { zlib: { level: 0 } });
  const finalName = `${sanitizeFilename(zipName || 'clonp_selecao')}.zip`;
  res.attachment(finalName);

  archive.pipe(res);
  archive.on('error', (err) => {
    console.error('Erro no batch zip:', err);
    if (!res.headersSent) res.status(500).end();
  });

  try {
    for (const id of ids) {
      const cached = fileInstancesCache.get(id);
      if (cached && cached.instance) {
        const fileStream = safeDownload(cached.instance);
        archive.append(fileStream, { name: cached.instance.name || 'arquivo' });
      }
    }
    await archive.finalize();
  } catch (err) {
    console.error('Erro ao empacotar seleção:', err);
  }
});

// 7. Rota de Keep-Alive / Health Check
app.get('/api/health', (req, res) => {
  res.send('OK');
});

// Auto-ping interno inteligente para manter a instância do Render ativa (Anti-Sleep)
const externalUrl = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || (process.env.PORT ? `http://localhost:${PORT}` : null);
if (externalUrl) {
  const keepAliveUrl = externalUrl.startsWith('http') ? `${externalUrl}/api/health` : `https://${externalUrl}/api/health`;
  setInterval(() => {
    axios.get(keepAliveUrl).catch(() => {});
  }, 9 * 60 * 1000); // Dispara a cada 9 minutos (abaixo dos 15min do Render sleep)
  console.log(`[Keep-Alive] Auto-ping ativo para manter acordado: ${keepAliveUrl}`);
}

// 8. Status do SmartProxy
app.get('/api/proxy-status', async (req, res) => {
  const now = Date.now();
  let inCooldown = 0;
  for (const exp of cooldownProxies.values()) {
    if (now < exp) inCooldown++;
  }

  res.json({
    smartProxyConfigured: proxyPool.length > 0,
    totalProxies: proxyPool.length,
    activeAvailable: Math.max(0, proxyPool.length - inCooldown),
    inCooldownCount: inCooldown
  });
});

app.listen(PORT, () => {
  console.log(`===============================================`);
  console.log(` Clonp rodando com sucesso e protegido!`);
  console.log(` Porta: ${PORT}`);
  console.log(` SmartProxy Failover: ${proxyPool.length > 0 ? `${proxyPool.length} proxies carregados` : 'Desativado (sem CUSTOM_PROXIES)'}`);
  console.log(`===============================================`);
});
