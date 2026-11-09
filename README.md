# Clonr Local (Versão Pessoal & 100% Gratuita)

Um clone leve, autônomo e de código aberto inspirado no **clonr.co**. Permite inspecionar pastas ou arquivos compartilhados do MEGA, navegar pelo conteúdo, reproduzir vídeos e áudios diretamente no navegador e realizar downloads com descriptografia em fluxo contínuo (*stream pipeline*), sem ocupar memória nem disco do servidor.

---

## 🚀 Como Executar

Abra o terminal nesta pasta (`c:\Users\Kevin Queiroz\Desktop\clonr`) e execute:

```bash
npm start
```

Abra seu navegador em: **`http://localhost:3000`**

---

## 🛠️ Arquitetura e Como Funciona

1. **Inspeção de Metadados (`/api/inspect`):**
   * O backend decodifica o hash (`#chave`) do link público do MEGA.
   * Consulta a API do MEGA para extrair a lista hierárquica de arquivos e tamanhos sem precisar transferir nenhum dado.
2. **Streaming em Pipeline (`/api/stream/:id`):**
   * O arquivo é transferido do MEGA em blocos criptografados (AES-128 CTR).
   * O backend descriptografa os blocos em tempo real e entrega diretamente como resposta HTTP (`chunked transfer`).
   * **Zero armazenamento local:** Não consome espaço no seu HD nem memória RAM.
3. **Suporte a `HTTP 206 Partial Content` (Range Requests):**
   * Permite que o player de vídeo ou áudio do navegador salte para qualquer minuto do vídeo instantaneamente sem precisar esperar o download completo.

---

## 💡 Próximas Melhorias Gratuitas Possíveis

* **Deploy gratuito na nuvem:** Pode ser publicado em plataformas gratuitas como **Render**, **Railway** ou **Koyeb** com 1 clique para acessar do celular.
* **Pool de Proxies Gratuitos:** Integrar rotação de proxies gratuitos para links que excedam a cota temporária de IP do MEGA.

