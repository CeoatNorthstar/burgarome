const THEME_STORAGE_KEY = 'burgarome-theme';

const THEMES = [
  { id: 'midnight', name: 'Midnight' },
  { id: 'ocean', name: 'Ocean' },
  { id: 'sunset', name: 'Sunset' },
  { id: 'aurora', name: 'Aurora' },
  { id: 'forest', name: 'Forest' },
  { id: 'lavender', name: 'Lavender' },
  { id: 'rose', name: 'Rose' },
  { id: 'gold', name: 'Gold' },
  { id: 'ember', name: 'Ember' },
  { id: 'glacier', name: 'Glacier' },
  { id: 'nebula', name: 'Nebula' },
  { id: 'citrus', name: 'Citrus' },
  { id: 'berry', name: 'Berry' },
  { id: 'slate', name: 'Slate' },
  { id: 'cobalt', name: 'Cobalt' },
  { id: 'mint', name: 'Mint' },
  { id: 'peach', name: 'Peach' },
  { id: 'wine', name: 'Wine' },
  { id: 'storm', name: 'Storm' },
  { id: 'candy', name: 'Candy' },
  { id: 'dusk', name: 'Dusk' },
  { id: 'dawn', name: 'Dawn' },
  { id: 'lagoon', name: 'Lagoon' },
  { id: 'volcano', name: 'Volcano' },
  { id: 'royal', name: 'Royal' },
  { id: 'honey', name: 'Honey' },
  { id: 'cosmic', name: 'Cosmic' },
  { id: 'jade', name: 'Jade' },
  { id: 'cherry', name: 'Cherry' },
  { id: 'arctic', name: 'Arctic' },
  { id: 'tropical', name: 'Tropical' },
  { id: 'plum', name: 'Plum' },
  { id: 'sand', name: 'Sand' },
  { id: 'ink', name: 'Ink' },
  { id: 'pulse', name: 'Pulse' },
  { id: 'frost', name: 'Frost' },
  { id: 'blaze', name: 'Blaze' },
  { id: 'meadow', name: 'Meadow' },
  { id: 'eclipse', name: 'Eclipse' },
  { id: 'prism', name: 'Prism' },
];

function applyTheme(themeId) {
  const theme = THEMES.find((entry) => entry.id === themeId) ?? THEMES[0];
  document.documentElement.dataset.theme = theme.id;
  localStorage.setItem(THEME_STORAGE_KEY, theme.id);
  document.querySelectorAll('[data-theme-id]').forEach((button) => {
    button.setAttribute('aria-pressed', button.dataset.themeId === theme.id ? 'true' : 'false');
  });
}

function initThemes() {
  const saved = localStorage.getItem(THEME_STORAGE_KEY);
  const valid = THEMES.some((entry) => entry.id === saved);
  applyTheme(valid ? saved : 'midnight');

  const grid = document.getElementById('themeGrid');
  if (!grid) {
    return;
  }

  grid.replaceChildren();
  for (const theme of THEMES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `theme-swatch theme-swatch--${theme.id}`;
    button.dataset.themeId = theme.id;
    button.setAttribute('aria-label', `${theme.name} theme`);
    button.setAttribute('aria-pressed', 'false');
    button.title = theme.name;

    const label = document.createElement('span');
    label.className = 'theme-swatch__label';
    label.textContent = theme.name;
    button.appendChild(label);

    button.addEventListener('click', () => applyTheme(theme.id));
    grid.appendChild(button);
  }

  applyTheme(document.documentElement.dataset.theme || 'midnight');
}
