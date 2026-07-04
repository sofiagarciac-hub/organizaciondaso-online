# Organizaciondaso Online

Aplicacion web para gestionar proyectos de equipo con tareas, responsables, acuerdos, reuniones y seguimiento. Esta version guarda los datos en una base SQLite del servidor.

## Ejecutar en tu computadora

```bash
npm install
npm start
```

Luego abre:

```text
http://localhost:3000
```

La base de datos se crea automaticamente en:

```text
data/organizaciondaso.sqlite
```

## Subir online

### Render

1. Sube esta carpeta a GitHub.
2. En Render crea un **Web Service** desde ese repositorio.
3. Usa:

```text
Build Command: npm install
Start Command: npm start
```

4. Agrega un **Disk** persistente montado en:

```text
/opt/render/project/src/data
```

5. Agrega esta variable:

```text
DATA_DIR=/opt/render/project/src/data
```

El archivo `render.yaml` ya incluye esa configuracion para despliegue tipo Blueprint.

Importante: usa siempre un disco/volumen persistente para que `organizaciondaso.sqlite` no se borre al reiniciar el servicio.
