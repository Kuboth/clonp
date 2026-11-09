# Clonp 🚀

Um cliente e reprodutor de links públicos do MEGA (**clonr.co**), 100% gratuito, moderno e otimizado para celulares e desktops.

O **Clonp** permite inspecionar pastas ou arquivos compartilhados do MEGA, navegar pela estrutura de diretórios, pré-visualizar arquivos em tela cheia e realizar downloads diretos ou em lote com descriptografia em tempo real (*stream pipeline*), sem consumir disco nem sobrecarregar o servidor.

---

## ✨ Funcionalidades Principais

* **⚡ Descriptografia e Streaming em Tempo Real:** Conexão direta AES-128 CTR entre os servidores do MEGA e o cliente via streaming contínuo. Zero consumo de disco no servidor.
* **⏩ Suporte a `HTTP 206 Partial Content` (Range Requests):** Permite avançar ou retroceder vídeos e áudios instantaneamente sem precisar aguardar o download do arquivo inteiro.
* **📱 PWA (Progressive Web App):** Instalável como aplicativo nativo no Android, iOS, Windows e Mac, com suporte a modo offline básico via Service Worker.
* **🎬 Player Universal com Autoplay Imediato:**
  * **Vídeos:** Início imediato sem duplo toque, suporte a legendas externas (`.srt` / `.vtt`) convertidas em tempo real para WebVTT e memória da última posição assistida (`localStorage`).
  * **Imagens & PDFs:** Visualizador com zoom e suporte a navegação por gestos de swipe.
  * **Áudios & Textos:** Player de áudio dedicado e leitor com sintaxe mono para `.txt` e `.log`.
* **🖼️ Miniaturas Inteligentes sob Demanda:** Geração e renderização leve de miniaturas para vídeos (via Canvas em baixa resolução) e imagens, processadas em fila sequencial com `IntersectionObserver` sem travar a rede.
* **📂 Modos de Visualização & Ordenação:**
  * Alternância fluida entre **Modo Lista** (compacto com divisores) e **Modo Grade** (cards limpos).
  * Ordenação por **Nome**, **Data de inclusão**, **Última alteração**, **Tipo**, **Tamanho** e **Duração**, com botão de alternância rápida **Crescente / Decrescente (A-Z / Z-A)**.
* **📦 Download em Lote (Seleção Múltipla):** Modo de seleção para marcar múltiplos arquivos e empacotar em `.zip` em tempo real sem arquivos temporários no servidor.
* **🛡️ Downloads Isolados e Estáveis:** Downloads desacoplados do ciclo de vida da página (não são cancelados caso a página seja recarregada ou atualizada).
* **👆 Gestos Mobile Nativos:**
  * Deslizar da borda esquerda para voltar de pasta.
  * Suporte nativo ao botão Voltar do Android/navegador (`popstate`).
  * Deslizar lateralmente dentro da galeria para alternar para o arquivo anterior ou seguinte.
* **🕒 Histórico Recente:** Acesso rápido às últimas 6 pastas ou links inspecionados.
* **🔄 Auto Keep-Alive:** Mecanismo integrado de auto-ping para manter instâncias gratuitas da nuvem (como Render) sempre ativas.

---

## 🚀 Como Executar Localmente

### Pré-requisitos
* [Node.js](https://nodejs.org/) (versão 18 ou superior)
* `git` instalado

### Instalação e Execução

1. Clone o repositório ou navegue até a pasta do projeto:
   ```bash
   git clone https://github.com/Kuboth/clonp.git
   cd clonp
   ```

2. Instale as dependências:
   ```bash
   npm install
   ```

3. Inicie o servidor:
   ```bash
   npm start
   ```

4. Acesse no navegador:
   ```
   http://localhost:3000
   ```

---

## 🌐 Deploy Gratuito na Nuvem (Render)

O Clonp está pré-configurado para implantação com 1 clique no **Render Free Web Service**:

1. Crie um repositório no GitHub (ou use um fork deste projeto).
2. Conecte sua conta do GitHub ao [Render.com](https://render.com).
3. Crie um **New Web Service**:
   * **Runtime:** `Node`
   * **Build Command:** `npm install`
   * **Start Command:** `npm start`
   * **Instance Type:** `Free`
4. *(Opcional)* Defina a variável de ambiente `RENDER_EXTERNAL_URL` com a URL pública gerada para ativar o **Keep-Alive automático** a cada 10 minutos.

---

## 🛠️ Stack Tecnológica

* **Backend:** Node.js, Express.js, `megajs`, `archiver`, `mime-types`, `srt-to-vtt`, `helmet`, `express-rate-limit`.
* **Frontend:** HTML5 semântico, Tailwind CSS (CDN), FontAwesome 6, Plyr.js, Service Worker API.

---

## 📄 Licença

Distribuído sob a licença MIT. Criado para uso pessoal e educacional.
