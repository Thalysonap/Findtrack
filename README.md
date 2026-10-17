# Fintrack

PWA local para controle de receitas, despesas, orçamentos e metas.

## Executar

Sirva a pasta por HTTP (o service worker não funciona via `file://`). Por exemplo:

```powershell
python -m http.server 8080
```

Depois, abra `http://localhost:8080`.

## Verificação

```powershell
npm test
npm run check
```

Os testes cobrem inicialização, valores monetários em centavos, datas, migração dos dados antigos, saldos, fluxo de caixa e backup versionado.

## Estrutura

- `js/core.js`: regras financeiras, moeda, validação, migração e backup.
- `js/storage.js`: persistência redundante em IndexedDB e localStorage.
- `js/notifications.js`: permissões e notificações enquanto o app está aberto.
- `js/script.js`: estado e interface.

## Privacidade

O PIN é um bloqueio visual local, derivado com PBKDF2 e atraso após tentativas incorretas. Ele não criptografa os registros armazenados no navegador. O PIN não é incluído em backups.
