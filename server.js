/**
 * @file server.js
 * @description Servidor clonp - Debrid, Streaming e Downloader para MEGA.nz
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
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
app.use(express.static(path.join(__dirname, 'public')));

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
  max: 600, // Permite múltiplos chunks para streams e Range requests
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

// Gerenciador de Proxies
let freeProxies = [];
let lastProxyFetch = 0;
let proxyIndex = 0;
const PROXY_ENABLED = process.env.ENABLE_MEGA_PROXY === 'true';

/**
 * Atualiza e mantém o pool de proxies HTTP/HTTPS
 * @returns {Promise<string[]>} Lista de proxies
 */
async function updateFreeProxies() {
  const now = Date.now();
  if (now - lastProxyFetch < 30 * 60 * 1000 && freeProxies.length > 0) {
    return freeProxies;
  }
  try {
    const res = await axios.get(
      'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt',
      { timeout: 5000 }
    );
    if (res.data) {
      freeProxies = res.data.split('\n').map(p => p.trim()).filter(Boolean);
      lastProxyFetch = now;
      console.log(`[Proxy Pool] Carregados ${freeProxies.length} proxies.`);
    }
  } catch (err) {
    console.warn('[Proxy Pool] Falha ao carregar proxies externos:', err.message);
  }
  return freeProxies;
}

updateFreeProxies();

/**
 * Retorna o próximo agente proxy rotacionado se configurado, ou null para conexão direta
 * @returns {HttpsProxyAgent<string> | null}
 */
function getNextProxyAgent() {
  if (!PROXY_ENABLED || freeProxies.length === 0) {
    return null;
  }
  const proxy = freeProxies[proxyIndex % freeProxies.length];
  proxyIndex++;
  try {
    return new HttpsProxyAgent(`http://${proxy}`);
  } catch (err) {
    return null;
  }
}

/**
 * Cria uma instância File da biblioteca megajs aplicando proxy se disponível
 * @param {string} url URL pública do MEGA
 * @returns {any}
 */
function createMegaFileInstance(url) {
  const agent = getNextProxyAgent();
  if (agent) {
    return File.fromURL(url, { httpAgent: agent, httpsAgent: agent });
  }
  return File.fromURL(url);
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
        const nodeId = `${node.downloadId || node.nodeId || Math.random().toString(36).substring(7)}`;
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
      const cacheKey = `${fileOrFolder.downloadId || fileOrFolder.nodeId || Math.random().toString(36).substring(7)}`;
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

// 2. Rota de streaming e download individual (Protegida por Rate Limit)
app.get('/api/stream/:id', streamLimiter, async (req, res) => {
  const { id } = req.params;
  const isDownload = req.query.download === '1';

  const cached = fileInstancesCache.get(id);
  if (!cached || !cached.instance) {
    return res.status(404).json({ error: 'Arquivo expirado ou não encontrado no cache. Inspecione o link novamente.' });
  }

  // Renova o TTL do arquivo que está sendo baixado/assistido
  cached.cachedAt = Date.now();
  const file = cached.instance;

  try {
    const filename = sanitizeFilename(file.name);
    const mimeType = mime.lookup(filename) || 'application/octet-stream';
    const fileSize = file.size;

    const headers = {
      'Content-Type': mimeType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800' // Cache de 24h no navegador para miniaturas instantâneas
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
        return file.download({ start, end }, (err, buf) => {
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
      const downloadStream = file.download({ start, end });
      downloadStream.on('error', (err) => {
        console.error('Stream error:', err);
        if (!res.headersSent) res.status(500).json({ error: 'Stream error: ' + (err.message || err) });
      });
      return downloadStream.pipe(res);
    }

    if (fileSize) {
      headers['Content-Length'] = fileSize;
    }

    // Para imagens e arquivos pequenos (< 8MB), entrega tudo em 1 único bloco com callback sem travar em proxies/Cloudflare
    if (fileSize && fileSize <= 8 * 1024 * 1024 && !isDownload) {
      return file.download({}, (err, buf) => {
        if (err) {
          console.error('Buffer download error:', err);
          if (!res.headersSent) res.status(500).json({ error: 'Erro no buffer download: ' + (err.message || err) });
          return;
        }
        res.writeHead(200, headers);
        res.end(buf);
      });
    }

    res.writeHead(200, headers);
    const downloadStream = file.download();
    downloadStream.on('error', (err) => {
      console.error('Stream error:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Stream full error: ' + (err.message || err) });
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
  const stream = cached.instance.download();

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
          const fileStream = cached.instance.download();
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
        const fileStream = cached.instance.download();
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
        const fileStream = cached.instance.download();
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

// Auto-ping interno para manter acordado se URL configurada (ou Render)
if (process.env.RENDER_EXTERNAL_URL) {
  const keepAliveUrl = `${process.env.RENDER_EXTERNAL_URL}/api/health`;
  setInterval(() => {
    axios.get(keepAliveUrl).catch(() => {});
  }, 10 * 60 * 1000); // A cada 10 minutos
  console.log(`[Keep-Alive] Auto-ping ativo para: ${keepAliveUrl}`);
}

// 8. Status do Pool de Proxies
app.get('/api/proxy-status', async (req, res) => {
  res.json({
    proxyEnabled: PROXY_ENABLED,
    activeProxiesCount: freeProxies.length,
    lastUpdate: new Date(lastProxyFetch).toLocaleTimeString()
  });
});

app.listen(PORT, () => {
  console.log(`===============================================`);
  console.log(` Clonp rodando com sucesso e protegido!`);
  console.log(` Porta: ${PORT}`);
  console.log(` Proxy Ativo: ${PROXY_ENABLED}`);
  console.log(`===============================================`);
});
