# Discord Join-and-Play Bot

Bot simplu care intră într-un canal vocal când un utilizator (non-bot) se conectează și redă un fișier audio scurt.

**Setup rapid**

- Clonează repo sau copiază fișierele în directorul proiectului.
- Creează un fișier `.env` (vezi `.env.example`) și pune `DISCORD_TOKEN`.
- Pune un fișier audio MP3 în `audio/clip.mp3` sau setează `AUDIO_PATH` în `.env`.

Comenzi:

```bash
npm install
npm start
```

Permisiuni bot: `Connect` și `Speak` în serverul Discord.

Fișiere importante:
- [index.js](index.js) — logica principală
- [package.json](package.json) — dependențe și start script
- [.env.example](.env.example) — exemplu config
