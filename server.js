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
const https = require('https');
const crypto = require('crypto');
const { File, API } = require('megajs');
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
/** @type {Map<string, { buffer: Buffer, contentType: string, cachedAt: number }>} */
const thumbnailMemoryCache = new Map();

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
  for (const [key, val] of thumbnailMemoryCache.entries()) {
    if (now - val.cachedAt > CACHE_TTL_MS) {
      thumbnailMemoryCache.delete(key);
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
 * Busca e valida proxies públicos rápidos e funcionais para o MEGA a partir de múltiplos agregadores
 * Incluindo: Proxifly (4.000+ proxies), TheSpeedX (2.500+ proxies) e monosans (500+ proxies)
 */
async function fetchAndVerifyProxies() {
  const sources = [
    'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt',
    'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt',
    'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt'
  ];

  let rawIps = [];
  for (const src of sources) {
    try {
      const data = await new Promise((resolve) => {
        const req = https.get(src, { timeout: 8000 }, (res) => {
          if (res.statusCode !== 200) return resolve('');
          let body = '';
          res.on('data', chunk => body += chunk);
          res.on('end', () => resolve(body));
        });
        req.on('error', () => resolve(''));
        req.on('timeout', () => { req.destroy(); resolve(''); });
      });

      if (data && data.length > 50) {
        const lines = data.split('\n')
          .map(l => l.trim().replace(/^https?:\/\//, ''))
          .filter(l => l && /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+:[0-9]+$/.test(l));
        rawIps.push(...lines);
      }
    } catch (e) {}
  }

  const unique = Array.from(new Set(rawIps)).sort(() => Math.random() - 0.5).slice(0, 60);
  if (unique.length === 0) return [];

  // Validação em lote concorrente testando handshake rápido com a API do MEGA via Axios
  const verified = await Promise.all(unique.map(async (ipPort) => {
    try {
      const agent = new HttpsProxyAgent(`http://${ipPort}`);
      const r = await axios.post('https://g.api.mega.co.nz/cs', '[]', {
        headers: { 'Content-Type': 'application/json' },
        httpsAgent: agent,
        httpAgent: agent,
        timeout: 3000,
        validateStatus: () => true
      });
      if (r && (r.status === 200 || r.status === 400)) {
        return `http://${ipPort}`;
      }
    } catch (e) {}
    return null;
  }));

  const active = verified.filter(Boolean);
  console.log(`[SmartProxy Mubeng-Engine] ${active.length} proxies ativos e testados no MEGA.`);
  return active;
}

/**
 * Carrega a lista de proxies estruturados a partir da variável de ambiente CUSTOM_PROXIES
 * e complementa com proxies públicos sob demanda.
 */
async function loadProxyPool() {
  const rawList = process.env.CUSTOM_PROXIES || '';
  let collected = [];

  if (rawList) {
    collected = rawList
      .split(/[,;\n]/)
      .map(p => p.trim())
      .filter(Boolean)
      .map(p => {
        if (!p.startsWith('http://') && !p.startsWith('https://') && !p.startsWith('socks5://')) {
          return `http://${p}`;
        }
        return p;
      });
  }

  // Se não houver proxies customizados fornecidos, carrega e valida pool público
  if (collected.length === 0) {
    const verifiedProxies = await fetchAndVerifyProxies();
    collected.push(...verifiedProxies);
  }

  proxyPool = Array.from(new Set(collected));
  console.log(`[SmartProxy] Pool ativo com ${proxyPool.length} proxy(ies) funcionais.`);
  return proxyPool;
}

// Inicializa pool e atualiza a cada 30 minutos
loadProxyPool();
setInterval(() => {
  if (!process.env.CUSTOM_PROXIES) {
    loadProxyPool();
  }
}, 30 * 60 * 1000);

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
 * Executa requisições de chunks através de Proxy via Axios (totalmente compatível com HttpsProxyAgent no Node 18+)
 * e retorna uma interface idêntica à Fetch Response para o megajs.
 * @param {string} proxyUrl 
 * @param {string} targetUrl 
 * @param {any} [opts] 
 */
async function fetchWithProxyAxios(proxyUrl, targetUrl, opts = {}) {
  const agent = createAgent(proxyUrl);
  if (!agent) throw new Error('Falha ao criar agente para o proxy');

  const headers = { ...(opts.headers || {}) };
  const method = (opts.method || 'GET').toLowerCase();

  const response = await axios({
    url: targetUrl,
    method,
    headers,
    httpsAgent: agent,
    httpAgent: agent,
    data: opts.body,
    responseType: 'arraybuffer',
    timeout: 8000,
    validateStatus: () => true
  });

  const buffer = Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data || '');

  return {
    status: response.status,
    headers: {
      get: (k) => response.headers[k.toLowerCase()]
    },
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    text: async () => buffer.toString('utf8'),
    json: async () => JSON.parse(buffer.toString('utf8')),
    body: response.data
  };
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
 * Converte base64 seguro para URL em Buffer
 * @param {string} b64 
 * @returns {Buffer}
 */
function base64ToBuffer(b64) {
  let s = b64.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

/**
 * Busca e descriptografa a miniatura nativa armazenada no MEGA (ufa / fa attribute)
 * @param {string} thumbHandle Handle do atributo fa (ex: 2-NvguUU_08)
 * @param {Buffer | string} fileKey Chave do arquivo (32 bytes)
 * @returns {Promise<{ buffer: Buffer, contentType: string }>}
 */
async function fetchMegaNativeThumbnail(thumbHandle, fileKey) {
  const api = new API(false);
  const handleBuf = base64ToBuffer(thumbHandle);

  const ufaRes = await new Promise((resolve, reject) => {
    api.request({
      a: 'ufa',
      fah: thumbHandle,
      ssl: 2,
      r: 1
    }, (err, res) => {
      if (err) reject(err);
      else resolve(res);
    });
  });

  if (!ufaRes || !ufaRes.p) throw new Error('MEGA não retornou URL para o atributo ufa');

  const u = new URL(ufaRes.p + '/0');
  const rawData = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: u.hostname,
      port: 443,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': handleBuf.length
      }
    }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`Storage retornou status HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.write(handleBuf);
    req.end();
  });

  if (rawData.length <= 12) throw new Error('Payload de miniatura corrompido ou truncado');
  const encData = rawData.slice(12);

  const keyBuf = Buffer.isBuffer(fileKey) ? fileKey : Buffer.from(fileKey, 'base64');
  const foldedKey = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) {
    foldedKey[i] = keyBuf[i] ^ keyBuf[i + 16];
  }

  const decipher = crypto.createDecipheriv('aes-128-cbc', foldedKey, Buffer.alloc(16, 0));
  decipher.setAutoPadding(false);
  let decrypted = Buffer.concat([decipher.update(encData), decipher.final()]);

  let contentType = 'image/jpeg';
  if (decrypted.length > 12 && decrypted.slice(8, 12).toString('ascii') === 'WEBP') {
    contentType = 'image/webp';
    const riffLen = decrypted.readUInt32LE(4);
    if (riffLen > 0 && riffLen + 8 <= decrypted.length) {
      decrypted = decrypted.slice(0, riffLen + 8);
    }
  } else if (decrypted.length > 4 && decrypted[0] === 0x89 && decrypted[1] === 0x50) {
    contentType = 'image/png';
  } else {
    // Trimming de padding para JPEG (termina com 0xFF, 0xD9)
    const eoiIdx = decrypted.lastIndexOf(Buffer.from([0xff, 0xd9]));
    if (eoiIdx > 0) {
      decrypted = decrypted.slice(0, eoiIdx + 2);
    }
  }

  return { buffer: decrypted, contentType };
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
      s: node.size,
      fa: node.fa || undefined
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
      if (decoded.fa) file.fa = decoded.fa;
      return file;
    }
  } catch (err) {}
  return null;
}
function safeDownload(file, options = {}, cb) {
  // Conectar SmartProxy diretamente no fetch do API do MEGA para garantir que 509 seja interceptado
  // e rotacionado sem abortar a stream
  if (file && file.api && !file.api._smartProxyHooked) {
    file.api._smartProxyHooked = true;
    const origFetch = file.api.fetch;

    file.api.fetch = async function(url, opts) {
      let res;
      try {
        res = await origFetch.call(this, url, opts);
      } catch (fetchErr) {
        // Se a chamada direta falhar por erro de rede ou quota
        const nextProxy = getNextAvailableProxy();
        if (nextProxy) {
          try {
            console.warn(`[SmartProxy Fetch Fallback] Erro na requisição direta, tentando via proxy ${nextProxy}...`);
            const proxyRes = await fetchWithProxyAxios(nextProxy, url, opts);
            if (proxyRes && proxyRes.status === 200) {
              return proxyRes;
            }
          } catch (e) {
            markProxyCooldown(nextProxy, 1800);
          }
        }
        throw fetchErr;
      }

      // Se o status retornado for 509 ou qualquer código de cota/erro de servidor
      if (res && (res.status === 509 || res.status === 429)) {
        console.warn(`[SmartProxy Failover] Status ${res.status} detectado na URL ${url.substring(0, 50)}...! Rotacionando proxy do pool...`);
        // Tenta proxies do pool verificado usando Axios com HttpsProxyAgent (100% suportado em Node 18+)
        for (let attempt = 0; attempt < 8; attempt++) {
          const nextProxy = getNextAvailableProxy();
          if (!nextProxy) break;

          try {
            const proxyRes = await fetchWithProxyAxios(nextProxy, url, opts);
            if (proxyRes && proxyRes.status === 200) {
              console.log(`[SmartProxy Bypass SUCESSO] Resposta 200 OK obtida via proxy ${nextProxy}!`);
              return proxyRes;
            } else if (proxyRes && (proxyRes.status === 509 || proxyRes.status === 429)) {
              markProxyCooldown(nextProxy, 3600);
            }
          } catch (proxyErr) {
            markProxyCooldown(nextProxy, 1800);
          }
        }
      }

      return res;
    };
  }

  let activeProxy = null;

  // Failover inteligente estilo MegaBasterd / SmartProxy
  const smartHandleRetries = (tries, error, retryCb) => {
    const errMsg = (error && error.message) ? error.message : String(error);
    const isBandwidthLimit = errMsg.includes('509') ||
      errMsg.includes('Bandwidth limit') ||
      errMsg.includes('rate limit') ||
      errMsg.includes('quota') ||
      errMsg.includes('RESOURCE_LIMIT');

    console.warn(`[SmartProxy Retry] Tentativa ${tries} - Erro detectado: ${errMsg}`);

    if (isBandwidthLimit) {
      if (activeProxy) {
        markProxyCooldown(activeProxy, 3600);
      }

      const nextProxy = getNextAvailableProxy();
      if (nextProxy && file && file.api) {
        activeProxy = nextProxy;
        const newAgent = createAgent(activeProxy);
        if (newAgent) {
          file.api.httpAgent = newAgent;
          file.api.httpsAgent = newAgent;
          console.log(`[SmartProxy Failover] Conexão alternada para proxy: ${activeProxy.replace(/:[^:@]+@/, ':***@')}`);
          return setTimeout(retryCb, 500);
        }
      }
    }

    if (tries > 8) {
      return retryCb(error);
    }

    const backoff = Math.min(1000 * Math.pow(1.5, tries), 8000);
    setTimeout(retryCb, backoff);
  };

  // Configuração inteligente com forceHttps para compatibilidade total com túneis HTTPS e proxies
  const speedOpts = {
    forceHttps: true,
    maxConnections: 2,
    initialChunkSize: 256 * 1024,
    chunkSizeIncrement: 256 * 1024,
    maxChunkSize: 1024 * 1024,
    handleRetries: smartHandleRetries,
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
      // Mapeamento dos atributos 'fa' (miniaturas/previews nativos do MEGA) para cada nó
      try {
        const rawNodes = await new Promise((resolve) => {
          fileOrFolder.api.request({
            a: 'f',
            c: 1,
            ca: 1,
            r: 1,
            _querystring: { n: fileOrFolder.downloadId }
          }, (err, res) => {
            if (!err && res && res.f) resolve(res.f);
            else resolve([]);
          });
        });

        const faMap = new Map();
        for (const n of rawNodes) {
          if (n.h && n.fa) faMap.set(n.h, n.fa);
        }

        const attachFaRecursive = (node) => {
          const h = Array.isArray(node.downloadId) ? node.downloadId[1] : node.downloadId;
          if (h && faMap.has(h)) {
            node.fa = faMap.get(h);
          }
          if (node.children && Array.isArray(node.children)) {
            node.children.forEach(attachFaRecursive);
          }
        };
        attachFaRecursive(fileOrFolder);
      } catch (faErr) {
        console.warn('[MEGA Native Thumbnails] Não foi possível mapear fa:', faErr.message);
      }

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
          hasThumbnail: !!(node.fa && (node.fa.includes(':0*') || node.fa.includes(':1*'))),
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

// 2.1 Rota de Miniaturas Nativas do MEGA (Zero Quota / Ultra Rápido ~9KB)
app.get('/api/thumbnail/:id', streamLimiter, async (req, res) => {
  const { id } = req.params;
  const isPreview = req.query.preview === '1'; // 0 = thumbnail (120x120), 1 = preview (maior resolução)

  // 1. Verifica cache em memória RAM
  const cacheKey = `${id}_${isPreview ? '1' : '0'}`;
  const memoryHit = thumbnailMemoryCache.get(cacheKey);
  if (memoryHit && memoryHit.buffer) {
    res.setHeader('Content-Type', memoryHit.contentType || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
    return res.end(memoryHit.buffer);
  }

  let file = null;
  const cached = fileInstancesCache.get(id);
  if (cached && cached.instance) {
    file = cached.instance;
  } else {
    file = resolveStatelessFile(id);
  }

  if (!file) {
    return res.status(404).send('Nó não encontrado.');
  }

  // Se o arquivo tiver o atributo 'fa' mapeado
  const faString = file.fa || (file.attributes && file.attributes.fa);
  if (!faString || typeof faString !== 'string') {
    return res.status(404).send('Miniatura não disponível para este arquivo.');
  }

  try {
    const parts = faString.split('/');
    let targetPart;
    if (isPreview) {
      targetPart = parts.find(p => p.includes(':1*')) || parts.find(p => p.includes(':0*')) || parts[0];
    } else {
      targetPart = parts.find(p => p.includes(':0*')) || parts[0];
    }

    if (!targetPart || !targetPart.includes('*')) {
      return res.status(404).send('Formato do atributo fa inválido.');
    }

    const thumbHandle = targetPart.split('*')[1];
    const thumbData = await fetchMegaNativeThumbnail(thumbHandle, file.key);

    // Salva em cache de memória (TTL de 2 horas)
    if (thumbData && thumbData.buffer) {
      thumbnailMemoryCache.set(cacheKey, {
        buffer: thumbData.buffer,
        contentType: thumbData.contentType,
        cachedAt: Date.now()
      });

      res.setHeader('Content-Type', thumbData.contentType);
      res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
      return res.end(thumbData.buffer);
    }

    return res.status(404).send('Falha ao processar miniatura.');
  } catch (err) {
    console.error(`[Thumbnail Endpoint] Erro ao extrair miniatura do nó ${file.name}:`, err.message);
    return res.status(500).send('Erro ao buscar miniatura.');
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

// Auto-ping interno para manter acordado se URL configurada (ou Render)
if (process.env.RENDER_EXTERNAL_URL) {
  const keepAliveUrl = `${process.env.RENDER_EXTERNAL_URL}/api/health`;
  setInterval(() => {
    axios.get(keepAliveUrl).catch(() => {});
  }, 10 * 60 * 1000); // A cada 10 minutos
  console.log(`[Keep-Alive] Auto-ping ativo para: ${keepAliveUrl}`);
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
