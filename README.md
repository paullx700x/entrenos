# EntreNós

Transferência de arquivos **direta entre navegadores**, sem upload intermediário. O projeto usa WebRTC DataChannel para transporte P2P, sinalização manual comprimida por código/QR, controle de backpressure e SHA-256 para verificar a integridade do arquivo recebido.

## Destaques

- Arquivo não é armazenado por um backend.
- Transporte WebRTC protegido por DTLS.
- Convites SDP comprimidos com `CompressionStream` quando disponível.
- QR Code opcional e fallback por copiar/colar código.
- Transferência em blocos de 64 KiB com controle de `bufferedAmount`.
- Validação SHA-256 antes de liberar o download.
- Interface responsiva e preparada para celular.

## Como testar

Sirva a pasta por HTTP/HTTPS (câmera e alguns recursos não funcionam em `file://`). Em dois dispositivos:

1. No remetente, clique em **Enviar arquivo** e escolha um arquivo.
2. No receptor, clique em **Receber arquivo** e leia/cole o convite.
3. O receptor gera uma resposta; devolva o QR/código ao remetente.
4. O remetente aplica a resposta e o DataChannel é aberto.
5. O receptor verifica o hash e libera o arquivo para download.

Para teste local rápido:

```bash
python -m http.server 4173
```

Abra `http://localhost:4173`.

## Observações de rede

O projeto usa STUN público para descoberta de rota. Em redes com NAT/firewall restritivo, uma conexão P2P pode exigir TURN. O EntreNós evita um backend de arquivos por design; um TURN opcional pode ser configurado no array `ICE` se for necessário para uso em produção.

## Privacidade

Os dados do arquivo trafegam pelo WebRTC DataChannel. O código de sinalização contém informações de conexão (SDP/ICE), então trate o convite como temporário e compartilhe apenas com o dispositivo desejado.

## Stack

HTML, CSS, JavaScript, WebRTC, Web Crypto API, Compression Streams API e BarcodeDetector quando disponível.

## Licença

MIT.
