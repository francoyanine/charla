// Íconos de trazo (24×24) para la interfaz. Uso: ico('home') → <svg>.
const P = {
  home: '<path d="M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  dm: '<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.6 8.6 0 0 1-3.8-.9L3 21l1.9-5.2A8.4 8.4 0 0 1 12 3a8.5 8.5 0 0 1 9 8.5z"/>',
  campana: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
  buscar: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4.2-4.2"/>',
  mas: '<path d="M12 5v14M5 12h14"/>',
  arroba: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.9 7.9"/>',
  emoji: '<circle cx="12" cy="12" r="9.5"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><path d="M9 9.5h.01M15 9.5h.01"/>',
  enviar: '<path d="M4 12 20 4l-6 16-3-6.5z"/><path d="m11 13.5 9-9.5"/>',
  negrita: '<path d="M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z"/>',
  cursiva: '<path d="M19 4h-9M14 20H5M15 4 9 20"/>',
  tachado: '<path d="M16 6.5A4 4 0 0 0 12 4c-2.5 0-4 1.4-4 3.2 0 1.3.8 2.2 2 2.8M14.5 14c.9.6 1.5 1.4 1.5 2.6 0 2-1.8 3.4-4.3 3.4A4.6 4.6 0 0 1 7.5 17.5M4 12h16"/>',
  enlace: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  lista: '<path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
  codigo: '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>',
  clip: '<path d="m21.4 11-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/>',
  hilo: '<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.6 8.6 0 0 1-3.8-.9L3 21l1.9-5.2A8.4 8.4 0 0 1 12 3a8.5 8.5 0 0 1 9 8.5z"/><path d="M8 10h8M8 14h5"/>',
  editar: '<path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  borrar: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
  abajo: '<path d="m6 9 6 6 6-6"/>',
  derecha: '<path d="m9 6 6 6-6 6"/>',
  cerrar: '<path d="M18 6 6 18M6 6l12 12"/>',
  nuevo: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  chispa: '<path d="M12 3l1.8 5.4L19 10l-5.2 1.6L12 17l-1.8-5.4L5 10l5.2-1.6z"/><path d="M19 15l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>',
  salir: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  personas: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  mas_h: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
};

export const ico = (nombre, clase = '') =>
  `<svg class="ico ${clase}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[nombre] || ''}</svg>`;
