# EntreNós

Transferência de arquivos **direta entre navegadores**, sem upload intermediário. O projeto usa WebRTC DataChannel para transporte P2P, sinalização manual comprimida por código/QR, controle de backpressure e SHA-256 para verificar a integridade do arquivo recebido.

## Destaques

- Arquivo não é armazenado por um backend.
- Transporte WebRTC protegido por DTLS.
- Convites SDP comprimidos com `CompressionStream` quando disponível.
- QR Code opcional e fallback por copiar/colar código.
- Transferência em blocos de 64 KiB com controle de `bufferedAmount`.
- Validação de tamanho e SHA-256 antes de liberar o download.
- Tratamento explícito para arquivo incompleto, canal encerrado e NAT restritivo.
- Interface responsiva e preparada para celular.

## Como testar

Sirva a pasta por HTTP/HTTPS (câmera e alguns recursos não funcionam em `file://`). Em dois dispositivos:

1. No remetente, clique em **Enviar arquivo** e escolha um arquivo.
2. No receptor, clique em **Receber arquivo** e leia/cole o convite.
3. O receptor gera uma resposta; devolva o QR/código ao remetente.
4. O remetente aplica a resposta e o DataChannel é aberto.
5. O receptor verifica tamanho + SHA-256 e só então libera o arquivo para download.

Para teste local rápido:

```bash
python -m http.server 4173
```

Abra `http://localhost:4173`.

## Autoteste

O núcleo expõe um autoteste no navegador. Abra o console e execute:

```js
await EntreNosSelfTest()
```

Ele verifica serialização/compressão da sinalização, reconstrói um arquivo determinístico de 1 MiB + 137 bytes em chunks, compara os hashes SHA-256 e informa se WebRTC/contexto seguro estão disponíveis.

## Observações de rede

O projeto usa STUN público para descoberta de rota. Em redes com NAT/firewall restritivo, uma conexão P2P pode exigir TURN. O EntreNós evita um backend de arquivos por design; um TURN opcional pode ser configurado no array `ICE` se for necessário para uso em produção.

O STUN não recebe o conteúdo do arquivo, mas participa da descoberta de conectividade e pode observar metadados de rede. O QR usa uma biblioteca carregada por CDN; se ela não carregar, copiar/colar o código continua funcionando.

## Privacidade

Os dados do arquivo trafegam pelo WebRTC DataChannel. O código de sinalização contém informações de conexão (SDP/ICE), então trate o convite como temporário e compartilhe apenas com o dispositivo desejado.

## Stack

HTML, CSS, JavaScript, WebRTC, Web Crypto API, Compression Streams API e BarcodeDetector quando disponível.

## Licença

MIT.
