const express = require('express');
const cors = require('cors');
const path = require('path');
const mime = require('mime-types');
const archiver = require('archiver');
const srt2vtt = require('srt-to-vtt');
const axios = require('axios');
const { File } = require('megajs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Cache em memória de instâncias de arquivos/pastas
const fileInstancesCache = new Map();
const folderCache = new Map();

// Gerenciador de Proxies Gratuitos
let freeProxies = [];
let lastProxyFetch = 0;

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
      console.log(`[Proxy Pool] Carregados ${freeProxies.length} proxies gratuitos.`);
    }
  } catch (err) {
    console.warn('[Proxy Pool] Falha ao carregar proxies externos:', err.message);
  }
  return freeProxies;
}

updateFreeProxies();

function formatBytes(bytes, decimals = 2) {
  if (!+bytes) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

// 1. Rota de inspeção do link com preservação de datas e atributos
app.post('/api/inspect', async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string' || !url.includes('mega.nz')) {
    return res.status(400).json({ error: 'URL do MEGA inválida. Certifique-se de que contenha a chave (#chave).' });
  }

  try {
    const fileOrFolder = File.fromURL(url);
    await fileOrFolder.loadAttributes();

    if (fileOrFolder.directory) {
      const folderKey = `folder_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      const allFiles = [];

      const buildTree = (node, currentPath = '') => {
        const nodeId = `${node.downloadId || node.nodeId || Math.random().toString(36).substring(7)}`;
        fileInstancesCache.set(nodeId, node);

        // Extrai timestamp se disponível (MEGA armazena timestamp em segundos)
        const timestamp = node.timestamp ? node.timestamp * 1000 : (node.mtime ? new Date(node.mtime).getTime() : Date.now());
        const ext = node.directory ? 'folder' : (node.name.split('.').pop() || '').toLowerCase();

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

      // Parear legendas .srt/.vtt automaticamente com vídeos em qualquer pasta
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

      folderCache.set(folderKey, { name: fileOrFolder.name || 'pasta', items: allFiles });

      return res.json({
        type: 'folder',
        folderKey,
        name: fileOrFolder.name || 'Pasta Compartilhada',
        totalFiles: allFiles.length,
        tree: rootTree
      });
    } else {
      const cacheKey = `${fileOrFolder.downloadId || fileOrFolder.nodeId || Math.random().toString(36).substring(7)}`;
      fileInstancesCache.set(cacheKey, fileOrFolder);

      const timestamp = fileOrFolder.timestamp ? fileOrFolder.timestamp * 1000 : Date.now();
      const ext = (fileOrFolder.name.split('.').pop() || '').toLowerCase();

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

// 2. Rota de streaming e download individual com Range (HTTP 206)
app.get('/api/stream/:id', async (req, res) => {
  const { id } = req.params;
  const isDownload = req.query.download === '1';

  const file = fileInstancesCache.get(id);
  if (!file) {
    return res.status(404).json({ error: 'Arquivo expirado ou não encontrado no cache. Inspecione o link novamente.' });
  }

  try {
    const filename = file.name || 'download';
    const mimeType = mime.lookup(filename) || 'application/octet-stream';
    const fileSize = file.size;

    const headers = {
      'Content-Type': mimeType,
      'Accept-Ranges': 'bytes'
    };

    if (isDownload) {
      headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(filename)}"`;
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
      res.writeHead(206, headers);

      const downloadStream = file.download({ start, end });
      downloadStream.on('error', (err) => {
        console.error('Stream error:', err);
        if (!res.headersSent) res.status(500).end();
      });
      return downloadStream.pipe(res);
    }

    if (fileSize) {
      headers['Content-Length'] = fileSize;
    }
    res.writeHead(200, headers);

    const downloadStream = file.download();
    downloadStream.on('error', (err) => {
      console.error('Stream error:', err);
      if (!res.headersSent) res.status(500).end();
    });
    downloadStream.pipe(res);

  } catch (err) {
    console.error('Erro no stream:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Falha no download/stream do arquivo.' });
    }
  }
});

// 3. Rota de conversão e streaming de legenda para WebVTT (Plyr)
app.get('/api/subtitles/:id', (req, res) => {
  const { id } = req.params;
  const file = fileInstancesCache.get(id);

  if (!file) {
    return res.status(404).send('Legenda não encontrada.');
  }

  res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
  const stream = file.download();

  if (file.name.endsWith('.srt')) {
    stream.pipe(srt2vtt()).pipe(res);
  } else {
    stream.pipe(res);
  }
});

// 4. Rota de download completo da pasta (.ZIP) em tempo real
app.get('/api/download-folder/:folderKey', async (req, res) => {
  const { folderKey } = req.params;
  const folderData = folderCache.get(folderKey);

  if (!folderData) {
    return res.status(404).send('Pasta não encontrada ou sessão expirada. Por favor, inspecione o link novamente.');
  }

  const archive = archiver('zip', {
    zlib: { level: 0 }
  });

  const zipName = `${folderData.name || 'mega_folder'}.zip`;
  res.attachment(zipName);

  archive.pipe(res);

  archive.on('error', (err) => {
    console.error('Erro no zip stream:', err);
    if (!res.headersSent) res.status(500).end();
  });

  try {
    for (const item of folderData.items) {
      if (!item.isDirectory) {
        const fileInstance = fileInstancesCache.get(item.id);
        if (fileInstance) {
          const fileStream = fileInstance.download();
          archive.append(fileStream, { name: item.path });
        }
      }
    }
    await archive.finalize();
  } catch (err) {
    console.error('Erro ao empacotar pasta:', err);
  }
});

// 5. Status do Pool de Proxies
app.get('/api/proxy-status', async (req, res) => {
  res.json({
    activeProxiesCount: freeProxies.length,
    lastUpdate: new Date(lastProxyFetch).toLocaleTimeString()
  });
});

app.listen(PORT, () => {
  console.log(`===============================================`);
  console.log(` Clonr Pro rodando com sucesso!`);
  console.log(` Acesse: http://localhost:${PORT}`);
  console.log(`===============================================`);
});
