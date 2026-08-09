# B-Cell Analysis - Electron App

Modern desktop application for B-cell repertoire analysis.

## Quick Start

### Development

```bash
npm install
npm run dev
```

The app will start in development mode with hot-reload enabled.

### Production Build

```bash
npm run build
npm start
```

### Create Distributable

```bash
npm run package:mac  # macOS .dmg and .zip
npm run package:win  # Windows installer
```

Output will be in `release/` directory.

## Architecture

- **Main Process** (`src/main/`): Node.js backend, spawns Python pipeline
- **Preload** (`src/preload/`): Secure IPC bridge between main and renderer
- **Renderer** (`src/renderer/`): Svelte UI, runs in browser context

## Scripts

- `npm run dev` - Start development mode with hot-reload
- `npm run build` - Build for production
- `npm run start` - Run the built app
- `npm run package` - Create distributable packages

## Technologies

- **Electron 28**: Desktop framework
- **Svelte 4**: Reactive UI framework
- **Vite 5**: Build tool and dev server
- **TypeScript**: Type safety
- **D3.js**: Visualizations
- **Python 3**: Backend analysis pipeline
