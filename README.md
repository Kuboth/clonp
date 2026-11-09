# clonp

Um jeito simples e direto de abrir pastas e arquivos públicos do MEGA pelo navegador, assistir a vídeos sem baixar tudo antes e fazer downloads sem frescura.

Criado como uma alternativa leve, rápida e gratuita inspirada no finado clonr.co, pensado para funcionar liso tanto no celular quanto no PC.

---

### O que dá pra fazer com ele:

- **Assistir vídeos direto no navegador:** Suporta streaming com seek instantâneo (avança e volta para qualquer minuto do vídeo sem engasgar). Se tiver legenda `.srt` ou `.vtt` na pasta, ele carrega junto automaticamente.
- **Não gasta disco do servidor:** O servidor não salva nada no HD. Ele apenas descriptografa os dados do MEGA em tempo real e joga direto pro seu navegador via stream contínuo.
- **Miniaturas na grade:** Gera pré-visualizações de imagens e vídeos usando IndexedDB no próprio navegador para não sobrecarregar a conexão. Mostra inclusive se o vídeo é 16:9 tradicional ou 9:16 (vertical).
- **Download individual ou em lote:** Baixe arquivos avulsos sem medo de cancelar se atualizar a aba, ou selecione vários arquivos e baixe tudo empacotado em `.zip`.
- **Navegação rápida:** Modos lista e grade, ordenação rápida (A-Z, tamanho, data) e histórico dos últimos links que você abriu.
- **PWA:** Dá pra instalar direto no celular como se fosse um aplicativo nativo.

---

### Rodando no seu PC

Você só precisa do **Node.js** (versão 18+) instalado.

```bash
# 1. Clone o projeto
git clone https://github.com/Kuboth/clonp.git
cd clonp

# 2. Instale as dependências
npm install

# 3. Inicie
npm start
```

Depois é só abrir no navegador em `http://localhost:3000`.

---

### Colocando no ar de graça (Render)

O projeto foi estruturado para rodar no plano gratuito do [Render](https://render.com) sem estourar limites de memória:

1. Suba este código para a sua conta no GitHub.
2. No Render, clique em **New +** > **Web Service** e selecione o repositório.
3. Configure:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
4. *(Dica)* Nas variáveis de ambiente do Render, adicione `RENDER_EXTERNAL_URL` com o endereço do seu site (ex: `https://meu-clonp.onrender.com`). O próprio servidor vai fazer um ping a cada 10 minutos para não deixar a máquina hibernar.

---

### Como foi feito

- **Backend:** Node.js, Express, `megajs`, `archiver`
- **Frontend:** HTML5, Tailwind CSS, Plyr.js, FontAwesome

---

### Licença

MIT. Use à vontade para seus estudos e projetos pessoais.
