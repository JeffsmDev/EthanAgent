# Despliegue — Ethan (Native English Coach)

## 1. Correr en local (Windows / macOS / Linux)

Requisitos: Node 22+, pnpm 10 (`corepack enable`).

```bash
pnpm install
cp packages/backend/.env.example packages/backend/.env   # y edítalo (ver tabla abajo)
pnpm dev          # backend http://localhost:4000 + frontend http://localhost:3000 (abre este)
```

Modo producción local (un solo proceso sirve API + frontend):

```bash
pnpm build
pnpm start        # http://localhost:4000
```

### Variables clave (`packages/backend/.env`)

| Variable | Valores | Notas |
|---|---|---|
| `AI_PROVIDER` | `gemini` \| `ollama` \| `mock` | Sin key válida, `gemini` arranca en modo demo y lo avisa en la UI |
| `GEMINI_API_KEY` | key de https://aistudio.google.com/apikey | Nunca la subas a git |
| `GEMINI_MODEL` | `gemini-2.0-flash` | Si la UI dice "model is not available", usa `gemini-2.5-flash` |
| `OLLAMA_BASE_URL` / `OLLAMA_MODEL` | `http://localhost:11434` / `llama3.1:latest` | En Docker: `http://host.docker.internal:11434` |
| `AI_TIMEOUT_MS` / `AI_MAX_RETRIES` | vacío = 30000/120000 ms y 2 | Tolerancia a fallos de red |
| `TTS_VOICE` | `en-US-ChristopherNeural`… | Voz neuronal de Edge |

## 2. VPS Hostinger (Ubuntu 22.04 / 24.04)

### 2.1 Preparación (una sola vez)

1. **DNS** — hPanel → Dominios → *DNS / Nameservers* → registro **A** `ethan` (o `@`) → IP de la VPS. Espera a que propague (`nslookup ethan.tudominio.com`).
2. **Firewall de hPanel** — si lo tienes activo en VPS → *Seguridad → Firewall*, permite **22, 80 y 443**.
3. **Subir el código** (elige una):
   - **GitHub (recomendado, permite actualizar con `git pull`)** — en tu PC:
     ```bash
     git init && git add . && git commit -m "Ethan v1"
     git remote add origin git@github.com:TU_USUARIO/teacher-english.git && git push -u origin main
     ```
     `.gitignore` ya excluye `.env`, `node_modules` y los datos del usuario. En la VPS:
     ```bash
     ssh root@IP_VPS
     git clone https://github.com/TU_USUARIO/teacher-english.git /opt/ethan   # repo privado: usa un token o deploy key
     ```
   - **Sin git** — desde tu PC (PowerShell), sin `node_modules`:
     ```powershell
     tar --exclude=node_modules --exclude=dist --exclude=.env --exclude=data -czf ethan.tgz .
     scp ethan.tgz root@IP_VPS:/opt/
     ssh root@IP_VPS "mkdir -p /opt/ethan && tar -xzf /opt/ethan.tgz -C /opt/ethan"
     ```

### 2.2 Deploy con un comando

```bash
cd /opt/ethan
sudo bash deploy/deploy.sh --domain ethan.tudominio.com --email tu@email.com --gemini-key TU_API_KEY
```

El script (idempotente, se puede re-ejecutar):
1. Instala `git`, `curl`, `nginx`, `certbot` (y Docker si falta).
2. Crea `packages/backend/.env` desde el ejemplo (permisos 600) y configura Gemini.
3. `docker compose up -d --build` → app en `127.0.0.1:3000` (no expuesta a Internet).
4. Espera a `/api/health`.
5. Configura Nginx (WebSocket/SSE, streaming de audio) y emite **SSL con Let's Encrypt** + redirección HTTPS.

Opciones: `--mode pm2` (sin Docker: Node 22 + pnpm + PM2 en el host), `--app-port 3000`, `--skip-nginx`, `--no-pull`. Ayuda: `bash deploy/deploy.sh --help`.

> ⚠️ **HTTPS es obligatorio para el micrófono.** Los navegadores solo permiten la Web Speech API en `https://` (o `localhost`).

### 2.3 Operación

| Tarea | Docker | PM2 |
|---|---|---|
| Actualizar | `git pull && sudo bash deploy/deploy.sh --domain … --email …` | igual con `--mode pm2` |
| Logs | `docker compose logs -f ethan` | `sudo -u ethan -H pm2 logs ethan-english-coach` |
| Reiniciar | `docker compose restart ethan` | `sudo -u ethan -H pm2 restart ethan-english-coach` |
| Estado | `curl -s 127.0.0.1:3000/api/health` | igual |
| Backup del progreso | `docker run --rm -v ethan_ethan-data:/d -v $PWD:/b alpine tar czf /b/ethan-data.tgz -C /d .` | `tar czf ethan-data.tgz -C packages/backend data` |
| Restaurar backup | `docker run --rm -v ethan_ethan-data:/d -v $PWD:/b alpine sh -c 'tar xzf /b/ethan-data.tgz -C /d && chown -R 1000:1000 /d'` (el contenedor corre como uid 1000) | `tar xzf ethan-data.tgz -C packages/backend && chown -R ethan: packages/backend/data` |
| Cambiar API key | editar `packages/backend/.env` → `docker compose up -d` | editar `.env` → reiniciar como arriba |

> En modo PM2 la app **nunca corre como root**: usa el dueño del repo o, si el repo es de root, el usuario de sistema `ethan` (los comandos de arriba asumen este caso). Por eso el repo debe estar en `/opt/ethan` y no dentro de `/root`.

### 2.4 Proteger el acceso (recomendado)

La app no tiene login: cualquiera con la URL puede usarla (y gastar tu cuota de Gemini) o resetear tu progreso.
Activa usuario/contraseña en Nginx:

```bash
sudo apt install -y apache2-utils
sudo htpasswd -c /etc/nginx/.ethan_htpasswd tu_usuario
sudo nano /etc/nginx/sites-available/ethan.conf   # descomenta auth_basic y auth_basic_user_file
sudo nginx -t && sudo systemctl reload nginx
```

### 2.5 Problemas frecuentes

| Síntoma | Causa / solución |
|---|---|
| Banner "Demo mode: no Gemini API key" | Falta `GEMINI_API_KEY` en `.env` → edita y reinicia |
| Banner "model is not available" | Google retiró el modelo → `GEMINI_MODEL=gemini-2.5-flash` |
| El micrófono no hace nada | Estás en `http://` → completa el SSL (re-ejecuta el script con `--email`) |
| Certbot falla | DNS aún no apunta a la VPS o el puerto 80 está bloqueado en el firewall de hPanel |
| Ethan responde pero no se oye | Edge TTS inaccesible: la app usa la voz del navegador como respaldo; revisa `docker compose logs` |
