// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Global type declarations for portal-web. TypeScript 6 made
// side-effect imports of non-TS files (CSS, asset paths) an error
// unless we declare a module shape for them. Next.js handles the
// runtime loading via webpack / turbopack; these declarations are
// purely for the type-checker.

declare module '*.css';
declare module '*.scss';
declare module 'maplibre-gl/dist/maplibre-gl.css';
