# clonp

Player e gerenciador leve para pastas e arquivos públicos do MEGA.nz, com streaming direto no navegador e download sem limites de disco.

---

### Recursos

- **Streaming direto no navegador:** Reprodução de vídeos com avanço/retrocesso instantâneo e suporte automático a legendas (`.srt` / `.vtt`).
- **Zero uso de disco no servidor:** Descriptografia em tempo real e entrega contínua por stream.
- **Visualizador de mídia:** Galeria com zoom para imagens e visualização de documentos.
- **SmartProxy Integrado:** Rotação de proxies e failover automático para contornar limites de cota de transferência (HTTP 509).
- **Download individual ou em lote:** Download de arquivos avulsos com suporte a retomada ou empacotamento em `.zip`.
- **Interface moderna e PWA:** Modos lista e grade, ordenação rápida e suporte a instalação como aplicativo.

---

### Como Rodar

Requer **Node.js 18+**.

```bash
# 1. Instalar dependências
npm install

# 2. Iniciar o servidor
npm start
```

Acesse no navegador: `http://localhost:3000`

---

### Licença

MIT
