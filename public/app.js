// Registro do Service Worker (PWA)
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }

    let deferredPrompt = null;
    const pwaInstallBtn = document.getElementById('pwaInstallBtn');
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      pwaInstallBtn.classList.remove('hidden');
    });

    pwaInstallBtn.addEventListener('click', async () => {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        if (outcome === 'accepted') {
          pwaInstallBtn.classList.add('hidden');
        }
        deferredPrompt = null;
      }
    });

    const inspectForm = document.getElementById('inspectForm');
    const urlInput = document.getElementById('urlInput');
    const btnInspect = document.getElementById('btnInspect');
    const loadingBox = document.getElementById('loadingBox');
    const resultsBox = document.getElementById('resultsBox');
    const errorBox = document.getElementById('errorBox');
    const errorMessage = document.getElementById('errorMessage');
    const fileListContainer = document.getElementById('fileListContainer');
    const breadcrumbs = document.getElementById('breadcrumbs');

    const sortMenuBtn = document.getElementById('sortMenuBtn');
    const sortDropdown = document.getElementById('sortDropdown');
    const currentSortLabel = document.getElementById('currentSortLabel');

    const mediaModal = document.getElementById('mediaModal');
    const modalTitle = document.getElementById('modalTitle');
    const mediaPlayerWrapper = document.getElementById('mediaPlayerWrapper');
    const closeModalBtn = document.getElementById('closeModalBtn');
    const galleryCounter = document.getElementById('galleryCounter');

    let rootNode = null;
    let currentFolderNode = null;
    let pathStack = []; 
    let activePlyr = null;
    let currentStreamUrl = '';

    let currentSortBy = localStorage.getItem('clonp_sort_by') || 'name';
    let isAscending = localStorage.getItem('clonp_sort_asc') !== 'false';
    let currentViewMode = localStorage.getItem('clonp_view_mode') || 'list';
    let lastScrollPosition = 0; // Armazena a posição exata da rolagem antes de abrir arquivos
    let lastOpenedItemId = null; // ID do último item aberto para scroll preciso

    // Gerenciador de Seleção em Lote
    let isSelectionMode = false;
    const selectedItemIds = new Set();

    // Galeria Swipe
    let viewableItemsList = [];
    let currentGalleryIndex = 0;

    // Histórico de Links Recentes
    const toggleHistoryBtn = document.getElementById('toggleHistoryBtn');
    const recentLinksContainer = document.getElementById('recentLinksContainer');
    const recentLinksList = document.getElementById('recentLinksList');

    toggleHistoryBtn.addEventListener('click', () => {
      recentLinksContainer.classList.toggle('hidden');
      renderRecentLinks();
    });

    function saveRecentLink(url, title) {
      let recent = JSON.parse(localStorage.getItem('clonp_recent_links') || '[]');
      recent = recent.filter(r => r.url !== url);
      recent.unshift({ url, title: title || url, date: Date.now() });
      if (recent.length > 6) recent.pop();
      localStorage.setItem('clonp_recent_links', JSON.stringify(recent));
      renderRecentLinks();
    }

    function renderRecentLinks() {
      const recent = JSON.parse(localStorage.getItem('clonp_recent_links') || '[]');
      if (!recent.length) {
        recentLinksList.innerHTML = `<div class="text-zinc-500 py-1 text-[11px]">Nenhum link recente salvo.</div>`;
        return;
      }
      recentLinksList.innerHTML = '';
      recent.forEach(r => {
        const item = document.createElement('div');
        item.className = 'flex items-center justify-between py-1 px-2 hover:bg-zinc-900 rounded-lg cursor-pointer transition';
        item.onclick = () => {
          urlInput.value = r.url;
          recentLinksContainer.classList.add('hidden');
          inspectForm.dispatchEvent(new Event('submit'));
        };
        item.innerHTML = `
          <div class="truncate flex-1 pr-2 text-zinc-300 font-medium text-xs">${r.title}</div>
          <i class="fa-solid fa-arrow-right text-[9px] text-zinc-600"></i>
        `;
        recentLinksList.appendChild(item);
      });
    }

    window.clearHistory = () => {
      localStorage.removeItem('clonp_recent_links');
      renderRecentLinks();
    };

    function setViewMode(mode) {
      currentViewMode = mode;
      localStorage.setItem('clonp_view_mode', mode);

      const listBtn = document.getElementById('viewListBtn');
      const gridBtn = document.getElementById('viewGridBtn');

      if (mode === 'grid') {
        gridBtn.className = 'w-7 h-7 rounded-md flex items-center justify-center text-xs transition bg-zinc-800 text-zinc-100 shadow-sm';
        listBtn.className = 'w-7 h-7 rounded-md flex items-center justify-center text-xs transition text-zinc-500 hover:text-zinc-300';
        fileListContainer.className = 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2.5';
      } else {
        listBtn.className = 'w-7 h-7 rounded-md flex items-center justify-center text-xs transition bg-zinc-800 text-zinc-100 shadow-sm';
        gridBtn.className = 'w-7 h-7 rounded-md flex items-center justify-center text-xs transition text-zinc-500 hover:text-zinc-300';
        fileListContainer.className = 'flex flex-col divide-y divide-zinc-850/80 bg-zinc-900/60 border border-zinc-800 rounded-xl overflow-hidden shadow-sm';
      }

      if (currentFolderNode) {
        renderFolder(currentFolderNode);
      }
    }

    const sortLabels = {
      name: 'Nome',
      date_desc: 'Data de inclusão',
      date_asc: 'Última alteração',
      type: 'Tipo',
      size: 'Tamanho',
      duration: 'Duração'
    };

    
    // Restaura interface da ordenação e direção salvas no localStorage
    if (sortLabels[currentSortBy]) {
      currentSortLabel.textContent = sortLabels[currentSortBy];
    }
    Object.keys(sortLabels).forEach(key => {
      const el = document.getElementById('check_' + key);
      if (el) {
        if (key === currentSortBy) el.classList.remove('hidden');
        else el.classList.add('hidden');
      }
    });
    const initialQuickIcon = document.getElementById('quickDirectionIcon');
    if (initialQuickIcon) {
      initialQuickIcon.className = isAscending ? 'fa-solid fa-arrow-up-a-z text-xs text-brand' : 'fa-solid fa-arrow-down-z-a text-xs text-brand';
    }

    sortMenuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      sortDropdown.classList.toggle('hidden');
    });

    document.addEventListener('click', (e) => {
      if (!sortDropdown.contains(e.target) && !sortMenuBtn.contains(e.target)) {
        sortDropdown.classList.add('hidden');
      }
    });

    window.changeSort = (sortKey) => {
      currentSortBy = sortKey;
      localStorage.setItem('clonp_sort_by', sortKey);
      currentSortLabel.textContent = sortLabels[sortKey];

      Object.keys(sortLabels).forEach(key => {
        const el = document.getElementById(`check_${key}`);
        if (el) {
          if (key === sortKey) el.classList.remove('hidden');
          else el.classList.add('hidden');
        }
      });

      sortDropdown.classList.add('hidden');
      if (currentFolderNode) {
        renderFolder(currentFolderNode);
      }
    };

    window.toggleSortDirection = () => {
      isAscending = !isAscending;
      localStorage.setItem('clonp_sort_asc', isAscending);
      const quickIcon = document.getElementById('quickDirectionIcon');
      if (quickIcon) {
        quickIcon.className = isAscending ? 'fa-solid fa-arrow-up-a-z text-xs text-brand' : 'fa-solid fa-arrow-down-z-a text-xs text-brand';
      }
      if (currentFolderNode) {
        renderFolder(currentFolderNode);
      }
    };

    function sortItems(items) {
      return [...items].sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;

        let result = 0;
        switch (currentSortBy) {
          case 'name':
            result = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
            break;
          case 'date_desc':
            result = (b.timestamp || 0) - (a.timestamp || 0);
            break;
          case 'date_asc':
            result = (a.timestamp || 0) - (b.timestamp || 0);
            break;
          case 'type':
            result = (a.extension || '').localeCompare(b.extension || '');
            break;
          case 'size':
            result = (a.size || 0) - (b.size || 0);
            break;
          case 'duration':
            result = (a.extension || '').localeCompare(b.extension || '');
            break;
          default:
            result = a.name.localeCompare(b.name);
        }

        return isAscending ? result : -result;
      });
    }

    function showToast(msg) {
      const toast = document.getElementById('toast');
      document.getElementById('toastMsg').textContent = msg;
      toast.classList.remove('hidden');
      setTimeout(() => toast.classList.add('hidden'), 2500);
    }

    function getFileIcon(filename) {
      const ext = filename.split('.').pop().toLowerCase();
      if (['mp4', 'mkv', 'avi', 'mov', 'webm', 'm4v', '3gp', 'flv', 'wmv', 'ts'].includes(ext)) return 'fa-film text-zinc-400';
      if (['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'opus'].includes(ext)) return 'fa-headphones text-zinc-400';
      if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff', 'heic', 'avif'].includes(ext)) return 'fa-image text-zinc-400';
      if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return 'fa-box-archive text-zinc-400';
      if (['pdf'].includes(ext)) return 'fa-file-lines text-zinc-400';
      if (['srt', 'vtt'].includes(ext)) return 'fa-closed-captioning text-zinc-400';
      return 'fa-file text-zinc-500';
    }

    function isViewable(filename) {
      const ext = filename.split('.').pop().toLowerCase();
      return isImage(filename) || isVideo(filename) || isAudio(filename) || isPdf(filename) || ['txt', 'log', 'json', 'md', 'xml'].includes(ext);
    }

    function isImage(filename) {
      const ext = filename.split('.').pop().toLowerCase();
      return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff', 'avif', 'heic'].includes(ext);
    }

    function isVideo(filename) {
      const ext = filename.split('.').pop().toLowerCase();
      return ['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi', '3gp', 'ogv'].includes(ext);
    }

    function isPdf(filename) {
      return filename.toLowerCase().endsWith('.pdf');
    }

    function isAudio(filename) {
      const ext = filename.split('.').pop().toLowerCase();
      return ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'opus'].includes(ext);
    }

    // Controle de Seleção em Lote
    window.toggleSelectMode = () => {
      isSelectionMode = !isSelectionMode;
      const btn = document.getElementById('toggleSelectModeBtn');
      const toolbar = document.getElementById('batchActionToolbar');

      if (isSelectionMode) {
        btn.classList.add('bg-brand', 'text-white');
        btn.classList.remove('bg-slate-900', 'text-slate-300');
        toolbar.classList.remove('hidden');
      } else {
        btn.classList.remove('bg-brand', 'text-white');
        btn.classList.add('bg-slate-900', 'text-slate-300');
        toolbar.classList.add('hidden');
        selectedItemIds.clear();
      }
      updateBatchUI();
      renderFolder(currentFolderNode);
    };

    function updateBatchUI() {
      document.getElementById('selectedCountText').textContent = `${selectedItemIds.size} selecionado(s)`;
    }

    window.selectAllCurrentFolder = () => {
      if (!currentFolderNode || !currentFolderNode.children) return;
      currentFolderNode.children.forEach(c => {
        if (!c.isDirectory) selectedItemIds.add(c.id);
      });
      updateBatchUI();
      renderFolder(currentFolderNode);
    };

    window.copyDirectDownloadLink = (id, e) => {
      if (e) e.stopPropagation();
      const directUrl = `${window.location.origin}/api/stream/${id}?download=1`;
      navigator.clipboard.writeText(directUrl).then(() => {
        showToast('Link direto copiado! (Cole no 1DM / Aria2 / Motrix / XDM)');
      }).catch(() => {
        prompt('Copie o link direto para o gerenciador:', directUrl);
      });
    };

    window.triggerDownload = (id) => {
      const url = `/api/stream/${id}?download=1`;
      showToast('Iniciando transferência...');
      const a = document.createElement('a');
      a.href = url;
      a.setAttribute('download', '');
      document.body.appendChild(a);
      a.click();
      setTimeout(() => document.body.removeChild(a), 100);
    };

    window.downloadSelectedBatch = async () => {
      if (selectedItemIds.size === 0) {
        showToast('Nenhum arquivo selecionado.');
        return;
      }
      showToast('Preparando pacote para download...');
      const ids = Array.from(selectedItemIds);
      
      try {
        const res = await fetch('/api/download-batch/prepare', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids, zipName: 'selecao_clonp' })
        });
        
        if (!res.ok) {
          throw new Error('Falha ao preparar o download.');
        }

        const data = await res.json();
        if (data.downloadUrl) {
          // Download via streaming nativo do navegador (não acumula Blob na RAM)
          const a = document.createElement('a');
          a.href = data.downloadUrl;
          a.setAttribute('download', 'selecao_clonp.zip');
          document.body.appendChild(a);
          a.click();
          setTimeout(() => document.body.removeChild(a), 200);
          showToast('Download iniciado!');
        } else {
          throw new Error('URL de download inválida.');
        }
      } catch (err) {
        console.error(err);
        showToast('Erro ao baixar lote.');
      }
    };

    inspectForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const url = urlInput.value.trim();
      if (!url) return;

      errorBox.classList.add('hidden');
      resultsBox.classList.add('hidden');
      loadingBox.classList.remove('hidden');
      btnInspect.disabled = true;

      try {
        const res = await fetch('/api/inspect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url })
        });
        const data = await res.json();

        if (!res.ok) {
          throw new Error(data.error || 'Erro ao processar o link.');
        }

        rootNode = data.tree;
        currentFolderNode = rootNode;
        pathStack = [{ name: data.name || 'Início', node: rootNode }];

        saveRecentLink(url, data.name || 'Pasta MEGA');

        setViewMode(currentViewMode);
        renderBreadcrumbs();
        renderFolder(currentFolderNode);
        resultsBox.classList.remove('hidden');
      } catch (err) {
        errorMessage.textContent = err.message;
        errorBox.classList.remove('hidden');
      } finally {
        loadingBox.classList.add('hidden');
        btnInspect.disabled = false;
      }
    });

    // ========================================================================
    // SISTEMA DE MINIATURAS INTELIGENTE: FILA CONTROLADA + CACHE DUPLO (RAM + IndexedDB)
    // ========================================================================
    const thumbMemoryCache = new Map(); // Cache RAM de acesso imediato (0ms)
    const pendingThumbQueue = [];       // Fila ordenada de requisições de miniaturas
    let activeThumbWorkers = 0;         // Contador de requisições paralelas ativas
    const MAX_CONCURRENT_THUMBS = 2;    // Máximo de 2 downloads concorrentes para nunca saturar conexões

    // 1. Observer de Interseção para Imagens e Vídeos
    const mediaThumbObserver = new IntersectionObserver((entries, observer) => {
      entries.forEach(async (entry) => {
        if (!entry.isIntersecting) return;
        const targetEl = entry.target;
        observer.unobserve(targetEl);

        const mediaId = targetEl.dataset.mediaId;
        const mediaType = targetEl.dataset.mediaType; // 'image' ou 'video'
        if (!mediaId) return;

        // A. Verifica no Cache em RAM
        if (thumbMemoryCache.has(mediaId)) {
          applyCachedThumbnail(targetEl, thumbMemoryCache.get(mediaId), mediaType);
          return;
        }

        // B. Verifica no IndexedDB permanente do navegador
        try {
          if (window.idbKeyval) {
            const cachedDb = await idbKeyval.get(`thumb_${mediaId}`);
            if (cachedDb) {
              thumbMemoryCache.set(mediaId, cachedDb);
              applyCachedThumbnail(targetEl, cachedDb, mediaType);
              return;
            }
          }
        } catch (e) {}

        // C. Adiciona na fila sequencial para carregamento controlado
        pendingThumbQueue.push({ mediaId, mediaType, targetEl });
        pumpThumbQueue();
      });
    }, { rootMargin: '180px 0px' });

    function applyCachedThumbnail(targetEl, cachedData, mediaType) {
      const dataUrl = typeof cachedData === 'object' ? cachedData.thumbUrl : cachedData;
      const isVertical = typeof cachedData === 'object' ? cachedData.isVertical : false;

      if (mediaType === 'image') {
        if (targetEl.tagName === 'IMG') {
          targetEl.src = dataUrl;
          targetEl.classList.remove('opacity-0');
        } else {
          targetEl.innerHTML = `<img src="${dataUrl}" class="w-full h-full object-cover transition-opacity duration-300 opacity-0" onload="this.classList.remove('opacity-0')">`;
        }
      } else {
        const badgeHtml = isVertical 
          ? `<div class="absolute bottom-1 right-1 bg-black/75 backdrop-blur-sm px-1 py-0.5 rounded text-[8px] text-zinc-300 font-mono leading-none border border-zinc-700/60 flex items-center space-x-0.5">
               <i class="fa-solid fa-mobile-screen-button text-[7px] text-zinc-400"></i>
               <span>9:16</span>
             </div>`
          : `<div class="absolute bottom-1 right-1 bg-black/75 backdrop-blur-sm px-1 py-0.5 rounded text-[8px] text-zinc-400 font-mono leading-none border border-zinc-700/60">
               16:9
             </div>`;

        targetEl.innerHTML = `
          <img src="${dataUrl}" class="w-full h-full object-cover transition-opacity duration-300 opacity-0" onload="this.classList.remove('opacity-0')">
          ${badgeHtml}
        `;
      }
    }

    function pumpThumbQueue() {
      while (activeThumbWorkers < MAX_CONCURRENT_THUMBS && pendingThumbQueue.length > 0) {
        activeThumbWorkers++;
        const task = pendingThumbQueue.shift();
        if (task.mediaType === 'image') {
          processImageTask(task);
        } else {
          processVideoTask(task);
        }
      }
    }

    // Processamento controlado de miniatura de IMAGEM
    function processImageTask(task) {
      const { mediaId, targetEl } = task;
      const streamUrl = `${window.location.origin}/api/stream/${mediaId}`;

      const img = new Image();
      img.decoding = 'async';

      const done = () => {
        activeThumbWorkers--;
        setTimeout(pumpThumbQueue, 40);
      };

      const timeout = setTimeout(() => {
        img.src = '';
        done();
      }, 9000);

      img.onload = () => {
        clearTimeout(timeout);
        try {
          // Compacta a imagem em miniatura leve (WebP/JPEG de 12KB) para salvar no IndexedDB
          const canvas = document.createElement('canvas');
          const maxDim = 280;
          let w = img.naturalWidth || 200;
          let h = img.naturalHeight || 200;
          if (w > h && w > maxDim) {
            h = Math.round((h * maxDim) / w);
            w = maxDim;
          } else if (h > maxDim) {
            w = Math.round((w * maxDim) / h);
            h = maxDim;
          }
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          const thumbUrl = canvas.toDataURL('image/jpeg', 0.70);

          thumbMemoryCache.set(mediaId, thumbUrl);
          if (window.idbKeyval) {
            idbKeyval.set(`thumb_${mediaId}`, thumbUrl).catch(() => {});
          }

          applyCachedThumbnail(targetEl, thumbUrl, 'image');
        } catch (e) {
          applyCachedThumbnail(targetEl, streamUrl, 'image');
        }
        done();
      };

      img.onerror = () => {
        clearTimeout(timeout);
        done();
      };

      img.src = streamUrl;
    }

    // Processamento controlado de miniatura de VÍDEO
    function processVideoTask(task) {
      const { mediaId, targetEl } = task;
      const streamUrl = `${window.location.origin}/api/stream/${mediaId}`;

      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';

      let isDone = false;
      const done = () => {
        if (isDone) return;
        isDone = true;
        video.src = '';
        video.load();
        video.remove();
        activeThumbWorkers--;
        setTimeout(pumpThumbQueue, 60);
      };

      const timeout = setTimeout(done, 9000);

      const captureFrame = () => {
        try {
          const vw = video.videoWidth || 16;
          const vh = video.videoHeight || 9;
          if (!video.videoWidth || !video.videoHeight) {
            clearTimeout(timeout);
            done();
            return;
          }
          const isVertical = vh > vw;

          const canvas = document.createElement('canvas');
          if (isVertical) {
            canvas.width = 135;
            canvas.height = 240;
          } else {
            canvas.width = 240;
            canvas.height = 135;
          }
          const ctx = canvas.getContext('2d');
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const thumbUrl = canvas.toDataURL('image/jpeg', 0.65);
          
          const cachePayload = { thumbUrl, isVertical };
          thumbMemoryCache.set(mediaId, cachePayload);

          if (window.idbKeyval) {
            idbKeyval.set(`thumb_${mediaId}`, cachePayload).catch(() => {});
          }

          applyCachedThumbnail(targetEl, cachePayload, 'video');
        } catch (e) {}
        clearTimeout(timeout);
        done();
      };

      video.addEventListener('loadedmetadata', () => {
        if (video.duration && !isNaN(video.duration) && video.duration > 0.5) {
          video.currentTime = Math.min(0.5, video.duration * 0.05);
        } else {
          captureFrame();
        }
      }, { once: true });

      video.addEventListener('loadeddata', captureFrame, { once: true });
      video.addEventListener('seeked', captureFrame, { once: true });
      video.addEventListener('error', done, { once: true });

      video.src = streamUrl;
    }

    function renderBreadcrumbs() {
      breadcrumbs.innerHTML = '';
      pathStack.forEach((entry, index) => {
        const isLast = index === pathStack.length - 1;
        const item = document.createElement('div');
        item.className = 'flex items-center space-x-1 flex-shrink-0';

        if (index > 0) {
          const sep = document.createElement('span');
          sep.className = 'text-zinc-600 text-[11px] px-0.5';
          sep.textContent = '/';
          item.appendChild(sep);
        }

        if (isLast) {
          const span = document.createElement('span');
          span.className = 'text-zinc-100 font-medium flex items-center space-x-1.5 bg-zinc-850 px-2 py-0.5 rounded-md border border-zinc-750 text-xs';
          span.innerHTML = `<i class="fa-solid fa-folder-open text-zinc-400 text-[11px]"></i> <span class="max-w-[120px] truncate">${entry.name}</span>`;
          item.appendChild(span);
        } else {
          const btn = document.createElement('button');
          btn.className = 'text-zinc-400 hover:text-zinc-200 transition flex items-center space-x-1 cursor-pointer py-0.5 px-1';
          btn.innerHTML = `<span class="max-w-[90px] truncate">${entry.name}</span>`;
          btn.onclick = () => {
            pathStack = pathStack.slice(0, index + 1);
            currentFolderNode = entry.node;
            renderBreadcrumbs();
            renderFolder(currentFolderNode);
          };
          item.appendChild(btn);
        }

        breadcrumbs.appendChild(item);
      });

      breadcrumbs.scrollLeft = breadcrumbs.scrollWidth;
    }

    let renderedItemsLimit = 40; // Renderiza os primeiros 40 arquivos para carga instantânea
    let currentFolderChildren = [];

    const scrollToTopBtn = document.getElementById('scrollToTopBtn');

    // Scroll infinito para carregar mais itens suavemente sem travar o celular & controle do botão Voltar ao Topo
    window.addEventListener('scroll', () => {
      const scrollY = window.scrollY || document.documentElement.scrollTop;

      // Exibe o botão de voltar ao topo quando rolar mais de 400px
      if (scrollToTopBtn) {
        if (scrollY > 400) {
          scrollToTopBtn.classList.remove('hidden');
        } else {
          scrollToTopBtn.classList.add('hidden');
        }
      }

      if ((window.innerHeight + scrollY) >= document.body.offsetHeight - 500) {
        if (renderedItemsLimit < currentFolderChildren.length) {
          renderedItemsLimit += 40;
          appendMoreItems();
        }
      }
    }, { passive: true });

    if (scrollToTopBtn) {
      scrollToTopBtn.addEventListener('click', () => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    }

    function appendMoreItems() {
      const slice = currentFolderChildren.slice(renderedItemsLimit - 40, renderedItemsLimit);
      slice.forEach(item => {
        const card = createItemCard(item);
        fileListContainer.appendChild(card);
      });
    }

    function renderFolder(folderNode) {
      fileListContainer.innerHTML = '';
      currentFolderChildren = folderNode.children || [];
      currentFolderChildren = sortItems(currentFolderChildren);
      renderedItemsLimit = 40;

      // Atualiza lista de itens visualizáveis para a galeria swipe
      viewableItemsList = currentFolderChildren.filter(c => !c.isDirectory && isViewable(c.name));

      // Botão "Voltar"
      if (pathStack.length > 1) {
        const backCard = document.createElement('div');
        if (currentViewMode === 'grid') {
          backCard.className = 'col-span-full bg-zinc-900/40 hover:bg-zinc-850/70 border border-zinc-800 rounded-lg p-2 flex items-center space-x-2 cursor-pointer text-zinc-300 active:scale-[0.99] transition touch-target';
          backCard.innerHTML = `
            <div class="w-6 h-6 rounded-md bg-zinc-800 flex items-center justify-center text-zinc-300">
              <i class="fa-solid fa-arrow-turn-up text-[10px]"></i>
            </div>
            <span class="font-medium text-xs text-zinc-300">.. Voltar pasta</span>
          `;
        } else {
          backCard.className = 'p-2.5 flex items-center space-x-2.5 cursor-pointer text-zinc-300 hover:bg-zinc-850/40 active:scale-[0.99] transition touch-target border-b border-zinc-850';
          backCard.innerHTML = `
            <div class="w-6 h-6 rounded-md bg-zinc-800 flex items-center justify-center text-zinc-300">
              <i class="fa-solid fa-arrow-turn-up text-[10px]"></i>
            </div>
            <span class="font-medium text-xs text-zinc-300">.. Voltar pasta</span>
          `;
        }
        backCard.onclick = () => {
          pathStack.pop();
          currentFolderNode = pathStack[pathStack.length - 1].node;
          renderBreadcrumbs();
          renderFolder(currentFolderNode);
        };
        fileListContainer.appendChild(backCard);
      }

      if (!currentFolderChildren.length) {
        const empty = document.createElement('div');
        empty.className = 'col-span-full py-12 text-center text-zinc-500 text-xs bg-zinc-900/20 rounded-xl border border-dashed border-zinc-800';
        empty.textContent = 'Esta pasta está vazia.';
        fileListContainer.appendChild(empty);
        return;
      }

      const initialBatch = currentFolderChildren.slice(0, renderedItemsLimit);
      initialBatch.forEach(item => {
        const card = createItemCard(item);
        fileListContainer.appendChild(card);
      });
    }

    function createItemCard(item) {
      const card = document.createElement('div');
      card.id = `item-card-${item.id}`;
      const iconClass = getFileIcon(item.name);
      const canView = isViewable(item.name);
      const isImg = isImage(item.name);
      const isVid = isVideo(item.name);
      const fullStreamUrl = `${window.location.origin}/api/stream/${item.id}`;
      const isSelected = selectedItemIds.has(item.id);

      if (currentViewMode === 'grid') {
        card.className = `bg-zinc-900/60 border ${isSelected ? 'border-zinc-200 ring-1 ring-zinc-200' : 'border-zinc-800/90'} rounded-xl p-2.5 flex flex-col justify-between transition hover:border-zinc-700 active:scale-[0.98] select-none cursor-pointer group shadow-sm relative`;

        if (item.isDirectory) {
          card.onclick = () => enterFolder(item.id);
          card.innerHTML = `
            <div class="flex flex-col items-center text-center py-2 flex-1 justify-center">
              <div class="w-12 h-12 rounded-xl bg-zinc-800/80 border border-zinc-750 flex items-center justify-center text-zinc-300 mb-2 group-hover:scale-105 transition">
                <i class="fa-solid fa-folder text-xl"></i>
              </div>
              <div class="font-medium text-xs text-zinc-200 line-clamp-2 w-full break-words leading-tight" title="${item.name}">${item.name}</div>
              <div class="text-[10px] text-zinc-500 font-mono mt-1">${item.children ? item.children.length + ' item(ns)' : 'Pasta'}</div>
            </div>
          `;
        } else {
          card.onclick = () => {
            if (isSelectionMode) {
              if (selectedItemIds.has(item.id)) selectedItemIds.delete(item.id);
              else selectedItemIds.add(item.id);
              updateBatchUI();
              renderFolder(currentFolderNode);
              return;
            }
            if (canView) {
              openPlayer(item.id, encodeURIComponent(item.name), item.subtitleId || '');
            } else {
              window.location.href = `/api/stream/${item.id}?download=1`;
            }
          };

          let thumbnailHtml = '';
          if (isImg) {
            thumbnailHtml = `
              <div class="thumb-media-container w-full h-28 rounded-lg overflow-hidden bg-zinc-950 border border-zinc-800/90 flex items-center justify-center mb-2 relative group-hover:border-zinc-700 transition" data-media-id="${item.id}" data-media-type="image">
                <div class="thumb-placeholder flex flex-col items-center justify-center text-zinc-500 text-[10px]">
                  <i class="fa-solid fa-image text-xl mb-1 text-zinc-600"></i>
                  <span>IMG</span>
                </div>
                <div class="absolute bottom-1 right-1 bg-black/70 backdrop-blur-sm px-1 py-0.5 rounded text-[9px] text-zinc-300 font-mono leading-none">
                  IMG
                </div>
              </div>`;
          } else if (isVid) {
            thumbnailHtml = `
              <div class="thumb-media-container w-full h-28 rounded-lg overflow-hidden bg-zinc-950 border border-zinc-800/90 flex flex-col items-center justify-center mb-2 relative group-hover:border-zinc-700 transition" data-media-id="${item.id}" data-media-type="video">
                <div class="w-9 h-9 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-400 flex items-center justify-center mb-1 group-hover:scale-110 transition">
                  <i class="fa-solid fa-play text-xs"></i>
                </div>
                <span class="text-[9px] text-zinc-500 uppercase font-mono tracking-wider">${item.extension || 'VIDEO'}</span>
              </div>`;
          } else if (isPdf(item.name)) {
            thumbnailHtml = `
              <div class="w-full h-28 rounded-lg bg-zinc-950 border border-zinc-800/90 flex flex-col items-center justify-center mb-2 relative group-hover:border-zinc-700 transition">
                <i class="fa-solid fa-file-lines text-2xl text-zinc-400 mb-1"></i>
                <span class="text-[9px] text-zinc-500 font-mono uppercase tracking-wider">PDF</span>
              </div>`;
          } else {
            thumbnailHtml = `
              <div class="w-full h-28 rounded-lg bg-zinc-950 border border-zinc-800/90 flex flex-col items-center justify-center mb-2 relative group-hover:border-zinc-700 transition">
                <i class="fa-solid ${iconClass} text-2xl mb-1"></i>
                <span class="text-[9px] text-zinc-500 uppercase font-mono">${item.extension || 'FILE'}</span>
              </div>`;
          }

          const checkMark = isSelectionMode 
            ? `<div class="absolute top-2 left-2 w-4 h-4 rounded ${isSelected ? 'bg-zinc-100 text-zinc-950' : 'bg-black/60 text-transparent border border-white/40'} flex items-center justify-center text-[10px]">
                 <i class="fa-solid fa-check"></i>
               </div>`
            : '';

          card.innerHTML = `
            ${checkMark}
            <div class="flex flex-col items-center text-center py-0.5 flex-1 justify-center min-w-0">
              ${thumbnailHtml}
              <div class="font-medium text-[11px] text-zinc-200 line-clamp-2 w-full break-words leading-tight" title="${item.name}">${item.name}</div>
              <div class="text-[10px] text-zinc-500 font-mono mt-1">${item.formattedSize}</div>
            </div>

            <div class="pt-2 border-t border-zinc-800/80 mt-1" onclick="event.stopPropagation()">
              <button 
                onclick="triggerDownload('${item.id}')"
                title="Baixar Arquivo"
                class="w-full py-1.5 bg-zinc-850 hover:bg-zinc-800 active:bg-zinc-750 text-zinc-300 hover:text-white border border-zinc-750 rounded-lg text-[11px] font-medium transition flex items-center justify-center space-x-1 cursor-pointer">
                <i class="fa-solid fa-download text-[10px]"></i>
                <span>Baixar</span>
              </button>
            </div>
          `;
        }

      } else {
        // Modo Lista
        card.className = `p-2.5 flex items-center justify-between gap-3 hover:bg-zinc-850/40 ${isSelected ? 'bg-zinc-800/60' : ''} active:bg-zinc-850/70 transition cursor-pointer select-none`;

        if (item.isDirectory) {
          card.onclick = () => enterFolder(item.id);
          card.innerHTML = `
            <div class="flex items-center space-x-2.5 min-w-0 flex-1">
              <div class="w-7 h-7 rounded-lg bg-zinc-800 border border-zinc-750 text-zinc-300 flex items-center justify-center flex-shrink-0">
                <i class="fa-solid fa-folder text-xs"></i>
              </div>
              <div class="min-w-0 flex-1">
                <div class="font-medium text-xs sm:text-sm text-zinc-200 truncate">${item.name}</div>
                <div class="text-[10px] text-zinc-500 font-mono">${item.children ? item.children.length + ' item(ns)' : 'Pasta'}</div>
              </div>
            </div>
            <i class="fa-solid fa-chevron-right text-[10px] text-zinc-600 pl-1"></i>
          `;
        } else {
          card.onclick = () => {
            if (isSelectionMode) {
              if (selectedItemIds.has(item.id)) selectedItemIds.delete(item.id);
              else selectedItemIds.add(item.id);
              updateBatchUI();
              renderFolder(currentFolderNode);
              return;
            }
            if (canView) {
              openPlayer(item.id, encodeURIComponent(item.name), item.subtitleId || '');
            } else {
              triggerDownload(item.id);
            }
          };

          const previewIconOrThumb = isImg 
            ? `<div class="thumb-media-container w-7 h-7 rounded-md overflow-hidden bg-zinc-950 border border-zinc-800 flex items-center justify-center flex-shrink-0" data-media-id="${item.id}" data-media-type="image">
                 <i class="fa-solid fa-image text-xs text-zinc-600"></i>
               </div>`
            : (isVid 
                ? `<div class="thumb-media-container w-7 h-7 rounded-md overflow-hidden bg-zinc-950 border border-zinc-800 flex items-center justify-center flex-shrink-0" data-media-id="${item.id}" data-media-type="video">
                     <i class="fa-solid fa-play text-[10px] text-zinc-500"></i>
                   </div>`
                : `<div class="w-7 h-7 rounded-md bg-zinc-900 border border-zinc-800 flex items-center justify-center flex-shrink-0">
                     <i class="fa-solid ${iconClass} text-xs"></i>
                   </div>`);

          const checkMarkList = isSelectionMode
            ? `<div class="w-3.5 h-3.5 rounded ${isSelected ? 'bg-zinc-100 text-zinc-950' : 'border border-zinc-600'} flex items-center justify-center text-[9px] mr-1 flex-shrink-0">
                 ${isSelected ? '<i class="fa-solid fa-check"></i>' : ''}
               </div>`
            : '';

          card.innerHTML = `
            <div class="flex items-center space-x-2.5 min-w-0 flex-1">
              ${checkMarkList}
              ${previewIconOrThumb}
              <div class="min-w-0 flex-1">
                <div class="font-medium text-xs sm:text-sm text-zinc-200 truncate leading-tight">${item.name}</div>
                <div class="flex items-center space-x-2 text-[10px] text-zinc-500 font-mono mt-0.5">
                  <span>${item.formattedSize}</span>
                  <span class="text-zinc-700">•</span>
                  <span>${item.formattedDate ? item.formattedDate.split(' ')[0] : ''}</span>
                  ${item.subtitleId ? '<span class="text-[9px] bg-zinc-800 text-zinc-300 px-1 py-0.2 rounded border border-zinc-700 font-mono">CC</span>' : ''}
                </div>
              </div>
            </div>

            <div onclick="event.stopPropagation()">
              <button 
                onclick="triggerDownload('${item.id}')"
                title="Baixar Arquivo"
                class="p-1.5 bg-zinc-850 hover:bg-zinc-800 active:bg-zinc-750 text-zinc-400 hover:text-white border border-zinc-750 rounded-md text-xs transition inline-flex items-center justify-center cursor-pointer">
                <i class="fa-solid fa-download text-[11px]"></i>
              </button>
            </div>
          `;
        }
      }

      const thumbTarget = card.querySelector('.thumb-media-container');
      if (thumbTarget) {
        mediaThumbObserver.observe(thumbTarget);
      }

      return card;
    }

    function goBackFolder() {
      if (!mediaModal.classList.contains('hidden')) {
        closePlayer(false);
        return true;
      }
      if (pathStack.length > 1) {
        pathStack.pop();
        currentFolderNode = pathStack[pathStack.length - 1].node;
        renderBreadcrumbs();
        renderFolder(currentFolderNode);
        return true;
      }
      return false;
    }

    window.enterFolder = (folderId) => {
      const targetFolder = (currentFolderNode.children || []).find(c => c.id === folderId);
      if (targetFolder) {
        pathStack.push({ name: targetFolder.name, node: targetFolder });
        currentFolderNode = targetFolder;
        history.pushState({ folderId, depth: pathStack.length, path: pathStack.map(p => p.name) }, '', `#folder-${pathStack.length}`);
        renderBreadcrumbs();
        renderFolder(currentFolderNode);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    };

    window.addEventListener('popstate', (e) => {
      if (!mediaModal.classList.contains('hidden')) {
        // Se o player estava aberto, fecha o player e NUNCA reseta a pasta
        closePlayer(false);
        return;
      }

      const state = e.state;
      if (state && typeof state.depth === 'number') {
        while (pathStack.length > state.depth && pathStack.length > 1) {
          pathStack.pop();
        }
        currentFolderNode = pathStack[pathStack.length - 1].node;
        renderBreadcrumbs();
        renderFolder(currentFolderNode);
      } else {
        goBackFolder();
      }
    });

    // Touch Swipe: Voltar pasta ou passar galeria
    let touchStartX = 0;
    let touchStartY = 0;

    document.addEventListener('touchstart', (e) => {
      if (e.touches && e.touches.length === 1) {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
      }
    }, { passive: true });

    document.addEventListener('touchend', (e) => {
      if (!e.changedTouches || e.changedTouches.length === 0) return;
      const touchEndX = e.changedTouches[0].clientX;
      const touchEndY = e.changedTouches[0].clientY;

      const diffX = touchEndX - touchStartX;
      const diffY = Math.abs(touchEndY - touchStartY);

      if (diffY < 70) {
        if (!mediaModal.classList.contains('hidden')) {
          // Swipe dentro da galeria (Próximo / Anterior)
          if (diffX > 60) navigateGallery(-1);
          else if (diffX < -60) navigateGallery(1);
        } else {
          // Swipe da borda esquerda para voltar pasta
          if (diffX > 75 && touchStartX < 90) {
            goBackFolder();
          }
        }
      }
    }, { passive: true });

    // Navegação de Galeria (Carrossel)
    window.navigateGallery = (direction) => {
      if (!viewableItemsList.length) return;
      currentGalleryIndex += direction;
      if (currentGalleryIndex < 0) currentGalleryIndex = viewableItemsList.length - 1;
      if (currentGalleryIndex >= viewableItemsList.length) currentGalleryIndex = 0;

      const target = viewableItemsList[currentGalleryIndex];
      if (target) {
        openPlayer(target.id, encodeURIComponent(target.name), target.subtitleId || '');
      }
    };

    let modalHistoryPushed = false;

        window.openPlayer = (id, encodedName, subtitleId) => {
      // Salva a posição exata da rolagem antes de abrir o modal
      lastScrollPosition = window.scrollY || document.documentElement.scrollTop || 0;
      lastOpenedItemId = id;

      if (!modalHistoryPushed) {
        history.pushState({ modalOpen: true }, '', '#preview');
        modalHistoryPushed = true;
      }

      if (activePlyr) {
        activePlyr.destroy();
        activePlyr = null;
      }

      const name = decodeURIComponent(encodedName);
      modalTitle.textContent = name;
      const ext = name.split('.').pop().toLowerCase();
      currentStreamUrl = `${window.location.origin}/api/stream/${id}`;

      // Localiza índice na galeria
      const foundIdx = viewableItemsList.findIndex(it => it.id === id);
      if (foundIdx !== -1) {
        currentGalleryIndex = foundIdx;
        galleryCounter.textContent = `${currentGalleryIndex + 1} / ${viewableItemsList.length}`;
      }

      // Download Rápido Direto no Modal (tanto no topo quanto no rodapé)
      const setupDownloadBtn = (btnId) => {
        const btn = document.getElementById(btnId);
        if (btn) {
          btn.onclick = (e) => {
            e.preventDefault();
            triggerDownload(id);
          };
        }
      };
      setupDownloadBtn('modalDownloadBtn');
      setupDownloadBtn('modalQuickDownloadBtn');

      mediaPlayerWrapper.innerHTML = '';

      if (isImage(name)) {
        // Pré-carregamento (Preload) da próxima e anterior imagem
        preloadNeighborImages(currentGalleryIndex);

        mediaPlayerWrapper.innerHTML = `
          <div id="imageZoomContainer" class="w-full h-full min-h-[300px] flex items-center justify-center p-2 bg-black overflow-hidden select-none relative cursor-zoom-in">
            <div id="imageLoadingSpinner" class="absolute flex flex-col items-center justify-center text-zinc-400">
              <i class="fa-solid fa-circle-notch fa-spin text-2xl text-brand mb-2"></i>
              <span class="text-xs">Carregando imagem...</span>
            </div>
            <img id="zoomableImage" src="${currentStreamUrl}" alt="${name}" 
              onload="document.getElementById('imageLoadingSpinner')?.remove(); initImageZoom();" 
              onerror="
                this.style.display='none';
                const spin = document.getElementById('imageLoadingSpinner');
                if (spin) spin.innerHTML = '<div class=\\'text-center p-4\\'><i class=\\'fa-solid fa-triangle-exclamation text-amber-500 text-3xl mb-2\\'></i><p class=\\'text-sm font-semibold text-zinc-200\\'>Limite de transferência atingido</p><p class=\\'text-xs text-zinc-400 mt-1 max-w-sm\\'>A cota temporária do MEGA foi atingida ou o arquivo requer download.</p></div>';
              "
              class="max-h-[82vh] max-w-full w-auto h-auto object-contain shadow-2xl transition-transform duration-100 ease-out will-change-transform">
            
            <div class="absolute bottom-2 left-2 bg-black/60 backdrop-blur-md px-2 py-1 rounded-md text-[10px] text-zinc-400 font-mono flex items-center space-x-1.5 pointer-events-none">
              <i class="fa-solid fa-magnifying-glass-plus text-zinc-300"></i>
              <span>Pinça / Scroll / 2x Clique para Zoom</span>
            </div>
          </div>
        `;
      } else if (isPdf(name)) {
        mediaPlayerWrapper.innerHTML = `
          <div class="w-full h-[82vh] bg-slate-900 rounded-lg overflow-hidden">
            <iframe src="${currentStreamUrl}" class="w-full h-full border-0"></iframe>
          </div>
        `;
      } else if (['txt', 'log'].includes(ext)) {
        mediaPlayerWrapper.innerHTML = `<div class="p-4 text-xs text-slate-400">Carregando visualização...</div>`;
        fetch(currentStreamUrl)
          .then(r => r.text())
          .then(text => {
            mediaPlayerWrapper.innerHTML = `
              <pre class="w-full h-[80vh] overflow-auto p-4 text-xs font-mono text-slate-200 bg-slate-950 rounded-xl whitespace-pre-wrap">${text.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
            `;
          })
          .catch(() => {
            mediaPlayerWrapper.innerHTML = `<div class="p-4 text-xs text-rose-400">Não foi possível carregar a pré-visualização.</div>`;
          });
      } else if (isAudio(name)) {
        mediaPlayerWrapper.innerHTML = `
          <div class="p-8 w-full flex flex-col items-center justify-center">
            <i class="fa-solid fa-compact-disc fa-spin text-6xl text-brand mb-6"></i>
            <audio id="playerTarget" controls class="w-full max-w-md">
              <source src="${currentStreamUrl}" type="audio/${ext === 'mp3' ? 'mpeg' : ext}">
            </audio>
          </div>
        `;
        activePlyr = new Plyr('#playerTarget', {
          controls: ['play', 'progress', 'current-time', 'duration', 'mute', 'volume']
        });
      } else {
        // Player de Vídeo com Autoplay Imediato e Retomada de Posição
        const video = document.createElement('video');
        video.id = 'playerTarget';
        video.controls = true;
        video.autoplay = true;
        video.playsInline = true;
        video.preload = 'auto';
        video.className = 'w-full max-h-[82vh] object-contain';

        let tracksHtml = '';
        if (subtitleId) {
          tracksHtml = `<track kind="captions" label="Português / Legenda" src="/api/subtitles/${subtitleId}" srclang="pt" default>`;
        }

        let videoMime = 'video/mp4';
        if (ext === 'webm') videoMime = 'video/webm';
        else if (ext === 'mov') videoMime = 'video/quicktime';
        else if (ext === 'm4v') videoMime = 'video/x-m4v';
        else if (ext === 'ogv') videoMime = 'video/ogg';
        else if (ext === 'mkv') videoMime = 'video/x-matroska';

        video.innerHTML = `<source src="${currentStreamUrl}" type="${videoMime}">${tracksHtml}`;
        
        const videoWrapper = document.createElement('div');
        videoWrapper.className = 'w-full h-full flex items-center justify-center relative overflow-hidden select-none';
        videoWrapper.appendChild(video);
        mediaPlayerWrapper.appendChild(videoWrapper);

        const preferredSpeed = parseFloat(localStorage.getItem('clonp_preferred_speed') || '1');

        const isMobileDevice = window.innerWidth <= 640;
        const playerControls = isMobileDevice
          ? [
              'play-large', 'play', 'progress', 'current-time', 'duration', 
              'captions', 'settings', 'pip', 'fullscreen'
            ]
          : [
              'play-large', 'play', 'progress', 'current-time', 'duration', 
              'mute', 'volume', 'captions', 'settings', 'pip', 'fullscreen'
            ];

        activePlyr = new Plyr('#playerTarget', {
          autoplay: true,
          controls: playerControls,
          seekTime: 10,
          speed: { selected: preferredSpeed, options: [0.5, 0.75, 1, 1.25, 1.5, 2] }
        });

        // Duplo Toque Inteligente no Celular com Efeito Visual de Onda
        let lastTapTime = 0;
        let lastTapSide = '';
        videoWrapper.addEventListener('touchend', (e) => {
          const currentTime = new Date().getTime();
          const tapInterval = currentTime - lastTapTime;
          const touch = e.changedTouches[0];
          if (!touch) return;

          const rect = videoWrapper.getBoundingClientRect();
          const tapX = touch.clientX - rect.left;
          const side = tapX > (rect.width / 2) ? 'right' : 'left';

          if (tapInterval < 340 && tapInterval > 0 && side === lastTapSide) {
            e.preventDefault();
            const isForward = side === 'right';
            if (isForward) {
              activePlyr.forward(10);
            } else {
              activePlyr.rewind(10);
            }
            triggerRippleAnimation(videoWrapper, touch.clientX, touch.clientY, isForward);
          }
          lastTapTime = currentTime;
          lastTapSide = side;
        });

        video.addEventListener('error', () => {
          mediaPlayerWrapper.innerHTML = `
            <div class="text-center p-6 flex flex-col items-center justify-center">
              <i class="fa-solid fa-triangle-exclamation text-amber-500 text-4xl mb-3"></i>
              <p class="text-sm font-semibold text-zinc-200">Não foi possível reproduzir este vídeo</p>
              <p class="text-xs text-zinc-400 mt-1 max-w-md">O formato pode requerer download direto ou o navegador não suporta este codec de vídeo.</p>
              <button onclick="triggerDownload('${id}')" class="mt-4 px-4 py-2 bg-brand text-zinc-950 font-medium text-xs rounded-lg hover:bg-brand-hover transition flex items-center space-x-2">
                <i class="fa-solid fa-download"></i>
                <span>Baixar Diretamente</span>
              </button>
            </div>
          `;
        });

        activePlyr.on('ratechange', () => {
          if (activePlyr.speed) {
            localStorage.setItem('clonp_preferred_speed', activePlyr.speed);
          }
        });

        if (ext === 'm3u8' && Hls.isSupported()) {
          const hls = new Hls({ maxBufferLength: 30 });
          hls.loadSource(currentStreamUrl);
          hls.attachMedia(video);
        }

        activePlyr.on('canplay', () => {
          activePlyr.play().catch(() => {});
        });

        const resumeStorageKey = `clonp_resume_${id}`;
        const savedTime = localStorage.getItem(resumeStorageKey);

        activePlyr.on('loadedmetadata', () => {
          if (savedTime && parseFloat(savedTime) > 5) {
            activePlyr.currentTime = parseFloat(savedTime);
            showToast(`Retomando aos ${Math.floor(parseFloat(savedTime) / 60)}m${Math.floor(parseFloat(savedTime) % 60)}s`);
          }
          activePlyr.play().catch(() => {});
        });

        activePlyr.on('timeupdate', () => {
          if (activePlyr.currentTime > 5) {
            localStorage.setItem(resumeStorageKey, activePlyr.currentTime);
          }
        });
      }

      mediaModal.classList.remove('hidden');
    };

    // Pré-carregamento de imagens vizinhas (Preload)
    function preloadNeighborImages(currentIndex) {
      if (!viewableItemsList.length) return;
      const nextIndex = (currentIndex + 1) % viewableItemsList.length;
      const prevIndex = (currentIndex - 1 + viewableItemsList.length) % viewableItemsList.length;

      const preloadUrl = (idx) => {
        const item = viewableItemsList[idx];
        if (item && isImage(item.name)) {
          const img = new Image();
          img.src = `/api/stream/${item.id}`;
        }
      };

      preloadUrl(nextIndex);
      preloadUrl(prevIndex);
    }

    // Efeito Visual de Onda do Duplo Toque (+10s / -10s)
    function triggerRippleAnimation(container, clientX, clientY, isForward) {
      const ripple = document.createElement('div');
      const rect = container.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;

      ripple.className = 'absolute pointer-events-none z-30 flex flex-col items-center justify-center bg-white/20 backdrop-blur-sm rounded-full w-24 h-24 -ml-12 -mt-12 text-white font-bold text-xs animate-ping';
      ripple.innerHTML = isForward ? '<span>+10s ⏩</span>' : '<span>⏪ -10s</span>';
      ripple.style.left = `${x}px`;
      ripple.style.top = `${y}px`;
      container.appendChild(ripple);
      setTimeout(() => ripple.remove(), 450);
    }

    // Zoom Interativo (Pinch-to-zoom, Roda do Mouse e Arraste Pan)
    function initImageZoom() {
      const container = document.getElementById('imageZoomContainer');
      const img = document.getElementById('zoomableImage');
      if (!container || !img) return;

      let scale = 1;
      let panX = 0;
      let panY = 0;
      let isDragging = false;
      let startX = 0;
      let startY = 0;
      let initialDistance = 0;

      const updateTransform = () => {
        if (scale <= 1) {
          scale = 1;
          panX = 0;
          panY = 0;
          container.style.cursor = 'zoom-in';
        } else {
          container.style.cursor = 'grab';
        }
        img.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
      };

      // Zoom com scroll da roda do mouse
      container.addEventListener('wheel', (e) => {
        e.preventDefault();
        const delta = e.deltaY < 0 ? 0.25 : -0.25;
        scale = Math.min(Math.max(1, scale + delta), 4.5);
        updateTransform();
      }, { passive: false });

      // Duplo clique para alternar zoom 1x e 2.5x
      container.addEventListener('dblclick', (e) => {
        scale = scale > 1 ? 1 : 2.5;
        panX = 0;
        panY = 0;
        updateTransform();
      });

      // Pan com arrasto de mouse
      container.addEventListener('mousedown', (e) => {
        if (scale > 1) {
          isDragging = true;
          startX = e.clientX - panX;
          startY = e.clientY - panY;
          container.style.cursor = 'grabbing';
        }
      });

      window.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        panX = e.clientX - startX;
        panY = e.clientY - startY;
        updateTransform();
      });

      window.addEventListener('mouseup', () => {
        isDragging = false;
        if (scale > 1) container.style.cursor = 'grab';
      });

      // Pinch to Zoom Mobile
      container.addEventListener('touchstart', (e) => {
        if (e.touches.length === 2) {
          initialDistance = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY
          );
        } else if (e.touches.length === 1 && scale > 1) {
          isDragging = true;
          startX = e.touches[0].clientX - panX;
          startY = e.touches[0].clientY - panY;
        }
      }, { passive: true });

      container.addEventListener('touchmove', (e) => {
        if (e.touches.length === 2 && initialDistance > 0) {
          e.preventDefault();
          const currentDistance = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY
          );
          const factor = currentDistance / initialDistance;
          scale = Math.min(Math.max(1, scale * (factor > 1 ? 1.05 : 0.95)), 4.5);
          updateTransform();
        } else if (e.touches.length === 1 && isDragging && scale > 1) {
          panX = e.touches[0].clientX - startX;
          panY = e.touches[0].clientY - startY;
          updateTransform();
        }
      }, { passive: false });

      container.addEventListener('touchend', () => {
        isDragging = false;
        initialDistance = 0;
      });
    }

    // Atalhos de Teclado no PC (Estilo YouTube)
    document.addEventListener('keydown', (e) => {
      if (mediaModal.classList.contains('hidden')) return;

      // Não intercepta se o usuário estiver digitando em campos de input
      if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;

      const key = e.key.toLowerCase();

      // Fechar modal
      if (key === 'escape') {
        closePlayer(true);
        return;
      }

      // Navegação de Galeria (Setas Esquerda e Direita quando imagem ou foco fora do video)
      if (key === 'arrowleft' && (!activePlyr || e.shiftKey)) {
        navigateGallery(-1);
        return;
      }
      if (key === 'arrowright' && (!activePlyr || e.shiftKey)) {
        navigateGallery(1);
        return;
      }

      if (activePlyr) {
        // Atalhos estilo YouTube para vídeo
        switch (key) {
          case ' ':
          case 'k':
            e.preventDefault();
            activePlyr.togglePlay();
            break;
          case 'f':
            e.preventDefault();
            activePlyr.fullscreen.toggle();
            break;
          case 'm':
            e.preventDefault();
            activePlyr.muted = !activePlyr.muted;
            showToast(activePlyr.muted ? 'Mudo 🔇' : 'Som 🔊');
            break;
          case 'j':
          case 'arrowleft':
            e.preventDefault();
            activePlyr.rewind(10);
            showToast('⏪ -10s');
            break;
          case 'l':
          case 'arrowright':
            e.preventDefault();
            activePlyr.forward(10);
            showToast('+10s ⏩');
            break;
          case 'arrowup':
            e.preventDefault();
            activePlyr.volume = Math.min(1, activePlyr.volume + 0.1);
            showToast(`Volume: ${Math.round(activePlyr.volume * 100)}%`);
            break;
          case 'arrowdown':
            e.preventDefault();
            activePlyr.volume = Math.max(0, activePlyr.volume - 0.1);
            showToast(`Volume: ${Math.round(activePlyr.volume * 100)}%`);
            break;
          default:
            // Teclas 0-9 para saltar porcentagens do vídeo
            if (key >= '0' && key <= '9') {
              e.preventDefault();
              const percent = parseInt(key, 10) * 0.1;
              if (activePlyr.duration) {
                activePlyr.currentTime = activePlyr.duration * percent;
                showToast(`Pulo para ${parseInt(key, 10) * 10}%`);
              }
            }
        }
      }
    });

    function closePlayer(triggerHistoryBack = true) {
      if (activePlyr) {
        activePlyr.destroy();
        activePlyr = null;
      }
      mediaPlayerWrapper.innerHTML = '';
      mediaModal.classList.add('hidden');

      if (modalHistoryPushed) {
        modalHistoryPushed = false;
        if (triggerHistoryBack && window.location.hash === '#preview') {
          history.back();
        }
      }

      // Garante que o card do item aberto esteja renderizado mesmo que tenha navegado na galeria
      if (currentGalleryIndex >= 0 && viewableItemsList[currentGalleryIndex]) {
        lastOpenedItemId = viewableItemsList[currentGalleryIndex].id;
      }

      if (lastOpenedItemId) {
        const itemIdx = currentFolderChildren.findIndex(it => it.id === lastOpenedItemId);
        if (itemIdx >= renderedItemsLimit) {
          // Carrega lotes adicionais se o usuário navegou além dos 40 itens na galeria
          while (renderedItemsLimit <= itemIdx && renderedItemsLimit < currentFolderChildren.length) {
            renderedItemsLimit += 40;
            appendMoreItems();
          }
        }
      }

      // Restaura a rolagem exatamente onde o usuário estava
      requestAnimationFrame(() => {
        if (lastOpenedItemId) {
          const el = document.getElementById(`item-card-${lastOpenedItemId}`);
          if (el) {
            el.scrollIntoView({ block: 'nearest', behavior: 'auto' });
            return;
          }
        }
        window.scrollTo({ top: lastScrollPosition, behavior: 'auto' });
      });
    }

    closeModalBtn.addEventListener('click', () => closePlayer(true));
    mediaModal.addEventListener('click', (e) => {
      if (e.target === mediaModal) closePlayer(true);
    });