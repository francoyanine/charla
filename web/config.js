// Configuración de Charla.
// Sin supabaseUrl la app corre en modo demo: todo queda en este navegador y las
// pestañas se hablan entre sí, para probarla sin servidor.
export const CONFIG = {
  nombreEspacio: 'Everfresh Media',
  // Solo estas cuentas de Google pueden entrar (además lo valida la base de datos).
  dominios: ['everfreshmedia.com'],
  supabaseUrl: 'https://swcvialsunqnwyuwkydy.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN3Y3ZpYWxzdW5xbnd5dXdreWR5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIxMjM4MTYsImV4cCI6MjEwNzY5OTgxNn0.OhG1H7GjY7WCTBS0v3kCcokVFocdcWQHVOUMky_copc',
};
