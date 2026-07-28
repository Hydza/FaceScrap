// Only panel-rendered strings live here; service-worker/offscreen errors stay console-only English.
// Pure module (no chrome.*) so it bundles in any context.

export type Lang = 'en' | 'es';

export type MsgKey =
  | 'brandTagline'
  // View switch (the three top-level pills).
  | 'viewNowPlaying'
  | 'viewLibrary'
  | 'viewSaved'
  // Nav landmarks (aria-label only).
  | 'ariaViews'
  | 'ariaFilters'
  // Now Playing.
  | 'nowStatus'
  | 'statusCapturing'
  | 'nowEmptyTitle'
  | 'nowEmptyBody'
  | 'videoQuality'
  // Count strings keep `{n}` inline and ship a `…One` twin instead of pulling in
  // plural rules: EN and ES both split at exactly one, and that is the whole need.
  | 'qualityOptions'
  | 'qualityOptionsOne'
  | 'piecesInPost'
  | 'piecesInPostOne'
  | 'nowDownloadable'
  | 'metaFormat'
  | 'metaDuration'
  | 'metaResolution'
  // Download button states (Now Playing's single action and each card's button).
  | 'downloadKind'
  | 'downloadMerging'
  | 'downloadSaving'
  | 'downloadRetry'
  | 'downloadItem'
  | 'unavailable'
  // Library / Saved grid.
  | 'libraryTitle'
  | 'librarySubtitle'
  | 'savedTitle'
  | 'savedSubtitle'
  | 'foundCount'
  | 'foundCountOne'
  | 'filterAll'
  | 'filterVideos'
  | 'filterImages'
  | 'yourPicks'
  | 'selectAll'
  | 'deselectAll'
  | 'selectItem'
  | 'cardPhoto'
  | 'libraryEmptyTitle'
  | 'libraryEmptyBody'
  | 'savedEmptyTitle'
  | 'savedEmptyBody'
  // Selection tray.
  | 'selectedCount'
  | 'selectedCountOne'
  | 'downloadSelected'
  | 'bulkBusy'
  // Composition words ("video + image"). Lowercase and singular: they are joined
  // into a phrase, never shown alone.
  | 'composeVideo'
  | 'composeImage'
  | 'composeAudio'
  // Card tags.
  | 'tagMayLackAudio'
  | 'tagAudioTrack'
  | 'tagFailed'
  | 'tagSavedGone'
  | 'titleBlobUnavailable'
  | 'titleSavedGone'
  | 'bannerDegraded'
  // Settings.
  | 'settings'
  | 'settingsAutosave'
  | 'titleSettings'
  | 'titleCloseSettings'
  | 'settingsDownloads'
  | 'settingsPanel'
  | 'settingsCapture'
  | 'settingsSavedData'
  | 'settingsTemplate'
  | 'settingsSubfolder'
  | 'settingsQuality'
  | 'settingsDirect'
  | 'settingsDirectHint'
  | 'settingsHdNote'
  | 'settingsLanguage'
  | 'settingsFollowLang'
  | 'settingsTheme'
  | 'settingsThemeHint'
  | 'settingsOrder'
  | 'settingsVideosOnly'
  | 'settingsMinRes'
  | 'settingsMaxItems'
  | 'settingsConfirmClear'
  | 'settingsClearList'
  | 'settingsClearHint'
  | 'settingsDiagnostics'
  | 'settingsDiagEnabled'
  | 'settingsDiagHint'
  | 'diagShow'
  | 'diagEmpty'
  | 'diagReset'
  | 'settingsRights'
  | 'clear'
  | 'qualityHighest'
  | 'qualityLowest'
  | 'qualityAsk'
  | 'themeAuto'
  | 'themeLight'
  | 'themeDark'
  | 'orderNewest'
  | 'orderOldest'
  | 'resNone'
  | 'maxUnlimited'
  | 'confirmClearPrompt'
  // Source + kind labels.
  | 'sourceReel'
  | 'sourceStory'
  | 'sourceHighlight'
  | 'sourceVideo'
  | 'sourcePage'
  | 'kindVideo'
  | 'kindImage'
  | 'kindAudio'
  // Download failure reasons. These reach the user as a card's `title` tooltip,
  // so they are panel copy and belong here — unlike the console-only
  // console.error text in content/, background/ and offscreen/.
  | 'errNoAudioTrack'
  | 'errMergeTimedOut'
  | 'errMergeFailed'
  | 'errDownloadFailed'
  | 'errInvalidTab'
  // Startup failure. Shown when the panel cannot boot at all, which is exactly
  // when the user most needs to read it in their own language.
  | 'fatalStartup'
  | 'fatalStartupVersion'
  // In-page download button (the overlay injected over the reel/story you are
  // watching, so a download needs no side panel).
  | 'overlayDownload'
  | 'overlayPickQuality'
  | 'overlayWorking'
  | 'overlayDone'
  | 'overlayFailed';

const MESSAGES: Record<Lang, Record<MsgKey, string>> = {
  en: {
    brandTagline: 'facebook memories, neatly saved',
    viewNowPlaying: 'Now Playing',
    viewLibrary: 'Library',
    viewSaved: 'Saved',
    ariaViews: 'Views',
    ariaFilters: 'Media filters',
    nowStatus: 'Now playing',
    statusCapturing: 'Capturing',
    nowEmptyTitle: 'Nothing playing',
    nowEmptyBody: 'Play a reel or story on this tab, or open your Library.',
    videoQuality: 'Resolution',
    qualityOptions: '{n}',
    qualityOptionsOne: '1',
    piecesInPost: '{n} pieces',
    piecesInPostOne: '1 piece',
    nowDownloadable: 'downloadable',
    metaFormat: 'Format',
    metaDuration: 'Duration',
    metaResolution: 'Resolution',
    downloadKind: 'Download {label}',
    downloadMerging: 'Merging…',
    downloadSaving: 'Saving…',
    downloadRetry: 'Retry',
    downloadItem: 'Download',
    unavailable: 'Unavailable',
    libraryTitle: 'Your media',
    librarySubtitle: 'Collected from this tab',
    savedTitle: 'Saved',
    savedSubtitle: 'Downloaded from this tab',
    foundCount: '{n} found',
    foundCountOne: '1 found',
    filterAll: 'All',
    filterVideos: 'Videos',
    filterImages: 'Images',
    yourPicks: 'Your picks',
    selectAll: 'Select all',
    deselectAll: 'Clear picks',
    selectItem: 'Select',
    cardPhoto: 'Photo',
    libraryEmptyTitle: 'No media yet',
    libraryEmptyBody: 'Play or scroll a Facebook post and it lands here.',
    savedEmptyTitle: 'Nothing saved yet',
    savedEmptyBody: 'Downloads you make from this tab show up here.',
    selectedCount: '{n} selected',
    selectedCountOne: '1 selected',
    downloadSelected: 'Download selected ({n})',
    bulkBusy: 'Saving {i}/{n}…',
    composeVideo: 'video',
    composeImage: 'image',
    composeAudio: 'audio',
    tagMayLackAudio: 'may lack audio',
    tagAudioTrack: 'audio track',
    tagFailed: 'failed',
    tagSavedGone: 'not on this page anymore',
    titleBlobUnavailable: 'This media is an MSE blob: and can\'t be saved.',
    titleSavedGone: 'Already downloaded. The capture is gone — replay it on this tab to re-enable downloading.',
    bannerDegraded:
      'This browser can\'t merge audio and video: HD saves as video only. Use Chrome or Edge to include audio.',
    settings: 'Settings',
    settingsAutosave: 'Changes save automatically',
    titleSettings: 'Settings',
    titleCloseSettings: 'Close settings',
    settingsDownloads: 'Downloads',
    settingsPanel: 'Panel',
    settingsCapture: 'Capture',
    settingsSavedData: 'Saved data',
    settingsTemplate: 'Filename',
    settingsSubfolder: 'Save in "FaceScrap/" subfolder',
    settingsQuality: 'Default quality',
    settingsDirect: 'Direct download',
    settingsDirectHint: 'May skip audio merge',
    settingsHdNote: 'HD video + audio merge automatically. Direct download may skip audio.',
    settingsLanguage: 'Language',
    settingsFollowLang: 'Follow browser language',
    settingsTheme: 'Theme',
    settingsThemeHint: 'Follows Facebook, then your device',
    settingsOrder: 'List order',
    settingsVideosOnly: 'Videos only',
    settingsMinRes: 'Minimum resolution',
    settingsMaxItems: 'Max saved items',
    settingsConfirmClear: 'Confirm before clearing',
    settingsClearList: 'Clear captured list',
    settingsClearHint: 'Library only · Saved stays',
    settingsDiagnostics: 'Diagnostics',
    settingsDiagEnabled: 'Count discarded captures',
    settingsDiagHint: 'Reload Facebook to apply',
    diagShow: 'Show counters',
    diagEmpty: 'Nothing recorded yet.',
    diagReset: 'Reset counters',
    settingsRights: 'Only download content you have the rights to.',
    clear: 'Clear',
    qualityHighest: 'Highest',
    qualityLowest: 'Lowest',
    qualityAsk: 'Ask',
    themeAuto: 'Auto',
    themeLight: 'Light',
    themeDark: 'Dark',
    orderNewest: 'Newest first',
    orderOldest: 'Oldest first',
    resNone: 'No minimum',
    maxUnlimited: 'Unlimited',
    confirmClearPrompt: 'Clear all captured items for this tab?',
    sourceReel: 'Reel',
    sourceStory: 'Story',
    sourceHighlight: 'Highlight',
    sourceVideo: 'Video',
    sourcePage: 'Image',
    kindVideo: 'Video',
    kindImage: 'Image',
    kindAudio: 'Audio',
    errNoAudioTrack: 'No audio track.',
    errMergeTimedOut: 'The merge timed out.',
    errMergeFailed: 'Merge failed.',
    errDownloadFailed: 'Download failed.',
    errInvalidTab: 'Invalid tab.',
    fatalStartup:
      "FaceScrap couldn't start on this browser ({message}). It needs a Chromium browser with the storage, tabs and side-panel APIs — try Chrome or Edge.",
    fatalStartupVersion: ' [v{version}]',
    overlayDownload: 'Download',
    overlayPickQuality: 'Choose a resolution',
    overlayWorking: 'Saving…',
    overlayDone: 'Saved',
    overlayFailed: 'Failed',
  },
  es: {
    brandTagline: 'recuerdos de facebook, bien guardados',
    viewNowPlaying: 'Ahora',
    viewLibrary: 'Biblioteca',
    viewSaved: 'Guardados',
    ariaViews: 'Vistas',
    ariaFilters: 'Filtros de contenido',
    nowStatus: 'Reproduciendo ahora',
    statusCapturing: 'Capturando',
    nowEmptyTitle: 'Nada reproduciéndose',
    nowEmptyBody: 'Reproduce un reel o historia en esta pestaña, o abre tu Biblioteca.',
    videoQuality: 'Resolución',
    qualityOptions: '{n}',
    qualityOptionsOne: '1',
    piecesInPost: '{n} piezas',
    piecesInPostOne: '1 pieza',
    nowDownloadable: 'descargable',
    metaFormat: 'Formato',
    metaDuration: 'Duración',
    metaResolution: 'Resolución',
    downloadKind: 'Descargar {label}',
    downloadMerging: 'Uniendo…',
    downloadSaving: 'Guardando…',
    downloadRetry: 'Reintentar',
    downloadItem: 'Descargar',
    unavailable: 'No disponible',
    libraryTitle: 'Biblioteca',
    librarySubtitle: 'Recopilado de esta pestaña',
    savedTitle: 'Guardados',
    savedSubtitle: 'Descargado de esta pestaña',
    foundCount: '{n} encontrados',
    foundCountOne: '1 encontrado',
    filterAll: 'Todo',
    filterVideos: 'Videos',
    filterImages: 'Imágenes',
    yourPicks: 'Tu selección',
    selectAll: 'Selec. todo',
    deselectAll: 'Quitar selección',
    selectItem: 'Seleccionar',
    cardPhoto: 'Foto',
    libraryEmptyTitle: 'Sin contenido aún',
    libraryEmptyBody: 'Reproduce o desplaza una publicación de Facebook y aparecerá aquí.',
    savedEmptyTitle: 'Nada guardado aún',
    savedEmptyBody: 'Las descargas que hagas desde esta pestaña aparecerán aquí.',
    selectedCount: '{n} seleccionados',
    selectedCountOne: '1 seleccionado',
    downloadSelected: 'Descargar ({n})',
    bulkBusy: 'Guardando {i}/{n}…',
    composeVideo: 'video',
    composeImage: 'imagen',
    composeAudio: 'audio',
    tagMayLackAudio: 'puede venir sin audio',
    tagAudioTrack: 'pista de audio',
    tagFailed: 'falló',
    tagSavedGone: 'ya no está en esta página',
    titleBlobUnavailable: 'Este medio es un blob: de MSE y no puede guardarse.',
    titleSavedGone: 'Ya descargado. La captura ya no está: reprodúcelo en esta pestaña para reactivar la descarga.',
    bannerDegraded:
      'Este navegador no puede unir audio y video: los HD se descargan solo con imagen. Usa Chrome o Edge para incluir el audio.',
    settings: 'Ajustes',
    settingsAutosave: 'Los cambios se guardan solos',
    titleSettings: 'Configuración',
    titleCloseSettings: 'Cerrar configuración',
    settingsDownloads: 'Descargas',
    settingsPanel: 'Panel',
    settingsCapture: 'Captura',
    settingsSavedData: 'Datos guardados',
    settingsTemplate: 'Nombre de archivo',
    settingsSubfolder: 'Subcarpeta «FaceScrap/»',
    settingsQuality: 'Calidad por defecto',
    settingsDirect: 'Descarga directa',
    settingsDirectHint: 'Puede omitir la unión de audio',
    settingsHdNote: 'Los HD unen video + audio solos. La descarga directa puede omitir el audio.',
    settingsLanguage: 'Idioma',
    settingsFollowLang: 'Seguir idioma del navegador',
    settingsTheme: 'Tema',
    settingsThemeHint: 'Sigue Facebook y luego tu dispositivo',
    settingsOrder: 'Orden de la lista',
    settingsVideosOnly: 'Solo videos',
    settingsMinRes: 'Resolución mínima',
    settingsMaxItems: 'Máx. de items guardados',
    settingsConfirmClear: 'Confirmar antes de vaciar',
    settingsClearList: 'Vaciar lista capturada',
    settingsClearHint: 'Solo Biblioteca · Guardados permanece',
    settingsDiagnostics: 'Diagnóstico',
    settingsDiagEnabled: 'Contar capturas descartadas',
    settingsDiagHint: 'Recarga Facebook para aplicar',
    diagShow: 'Ver contadores',
    diagEmpty: 'Nada registrado aún.',
    diagReset: 'Reiniciar contadores',
    settingsRights: 'Descarga solo contenido sobre el que tengas derechos.',
    clear: 'Vaciar',
    qualityHighest: 'Mayor',
    qualityLowest: 'Menor',
    qualityAsk: 'Preguntar',
    themeAuto: 'Automático',
    themeLight: 'Claro',
    themeDark: 'Oscuro',
    orderNewest: 'Más nuevo primero',
    orderOldest: 'Más viejo primero',
    resNone: 'Sin mínimo',
    maxUnlimited: 'Sin límite',
    confirmClearPrompt: '¿Vaciar todos los items capturados de esta pestaña?',
    sourceReel: 'Reel',
    sourceStory: 'Historia',
    sourceHighlight: 'Destacada',
    sourceVideo: 'Video',
    sourcePage: 'Imagen',
    kindVideo: 'Video',
    kindImage: 'Imagen',
    kindAudio: 'Audio',
    errNoAudioTrack: 'Sin pista de audio.',
    errMergeTimedOut: 'La unión tardó demasiado.',
    errMergeFailed: 'Falló la unión.',
    errDownloadFailed: 'Falló la descarga.',
    errInvalidTab: 'Pestaña no válida.',
    fatalStartup:
      'FaceScrap no pudo arrancar en este navegador ({message}). Necesita un navegador Chromium con las APIs de storage, tabs y panel lateral — prueba Chrome o Edge.',
    fatalStartupVersion: ' [v{version}]',
    overlayDownload: 'Descargar',
    overlayPickQuality: 'Elige una resolución',
    overlayWorking: 'Guardando…',
    overlayDone: 'Guardado',
    overlayFailed: 'Falló',
  },
};

let currentLang: Lang = 'en';

export function setLang(lang: Lang): void {
  currentLang = lang;
}

export function getLang(): Lang {
  return currentLang;
}

export function t(key: MsgKey): string {
  return MESSAGES[currentLang][key];
}

/** Fill a message's `{placeholder}` slots: fmt('bulkBusy', { i: 1, n: 3 }).
 *  Each placeholder appears at most once per message, so plain replace() is
 *  enough — this exists so call sites stop hand-chaining replacements.
 *  The replacement is passed as a FUNCTION, not a string: a string
 *  replacement re-interprets `$$`, `$&`, `` $` ``, `$'` and `$<name>` in the
 *  value (GetSubstitution), so a value containing one would corrupt the
 *  output; a function's return value is always inserted literally. */
export function fmt(key: MsgKey, vars: Record<string, string | number>): string {
  let s = t(key);
  for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, () => String(v));
  return s;
}

/** Where the manual language choice is stored. */
export const LANG_KEY = 'lang';

export async function loadLang(): Promise<Lang> {
  const stored = (await chrome.storage.local.get(LANG_KEY))[LANG_KEY];
  return stored === 'es' ? 'es' : 'en';
}

export async function saveLang(lang: Lang): Promise<void> {
  await chrome.storage.local.set({ [LANG_KEY]: lang });
}

/** The language to use: the browser's when "follow browser language" is on,
 *  otherwise the manually-saved choice. Shared so the in-page download overlay
 *  localises exactly like the panel — it used to live inside sidepanel.ts, where
 *  a content script could not reach it. */
export async function resolveLang(followBrowserLang: boolean): Promise<Lang> {
  if (followBrowserLang) {
    return (navigator.language || 'en').toLowerCase().startsWith('es') ? 'es' : 'en';
  }
  return loadLang();
}
