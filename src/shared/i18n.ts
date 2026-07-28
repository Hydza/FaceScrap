// Only panel-rendered strings live here; service-worker/offscreen errors stay console-only English.
//
// The table and t()/fmt() are chrome-free, but loadLang/saveLang/resolveLang below use
// chrome.storage.local — so this bundles into the panel and the ISOLATED-world content
// script, NEVER the MAIN-world page hook or the offscreen document, neither of which has
// chrome.storage. (The header used to claim the whole module was chrome-free.)

export type Lang = 'en' | 'es';

export type MsgKey =
  // Header.
  | 'statusCapturing'
  | 'statusWatching'
  | 'statusQueue'
  | 'statusQueueOne'
  // View switch (the four nav items).
  | 'viewNowPlaying'
  | 'viewLibrary'
  | 'viewSaved'
  // Nav landmarks (aria-label only).
  | 'ariaViews'
  | 'ariaFilters'
  | 'ariaGridDensity'
  // Now Playing.
  | 'nowStatus'
  | 'nowEmptyTitle'
  | 'nowEmptyBody'
  | 'nowEmptyPromise'
  | 'nowEmptyToLibrary'
  | 'videoQuality'
  // Count strings keep `{n}` inline and ship a `…One` twin instead of pulling in
  // plural rules: EN and ES both split at exactly one, and that is the whole need.
  | 'piecesInPost'
  | 'piecesInPostOne'
  // The resolution picker's note: "4 available · up to 2560×1440".
  | 'resAvailable'
  | 'resAvailableOne'
  | 'resUpTo'
  | 'ariaResolutionList'
  // The pill over the media that says whether the file will have sound.
  | 'mediaAudioOk'
  | 'mediaAudioMuted'
  // Where the file lands, under the primary button.
  | 'savesToFolder'
  | 'savesToRoot'
  | 'saveAs'
  // Download button states (Now Playing's single action and each card's button).
  | 'nowSave'
  | 'downloadMerging'
  | 'downloadSaving'
  | 'downloadRetry'
  | 'unavailable'
  // Library / Saved grid.
  | 'libraryTitle'
  | 'savedTitle'
  | 'onThisTab'
  | 'onThisTabOne'
  | 'filesCount'
  | 'filesCountOne'
  | 'openFolder'
  | 'scrollForMore'
  | 'filterAll'
  | 'filterVideos'
  | 'filterImages'
  | 'selectAll'
  | 'deselectAll'
  | 'selectItem'
  | 'cardPhoto'
  | 'badgeOnDisk'
  | 'badgeCaptureGone'
  | 'titleRevealFolder'
  | 'libraryEmptyTitle'
  | 'libraryEmptyBody'
  | 'savedEmptyTitle'
  | 'savedEmptyBody'
  // Selection tray.
  | 'selectedCount'
  | 'selectedCountOne'
  | 'traySave'
  | 'trayRemux'
  | 'trayRemuxOne'
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
  | 'titleBlobUnavailable'
  | 'titleSavedGone'
  | 'bannerDegraded'
  // Settings.
  | 'settings'
  | 'settingsAutosave'
  | 'settingsSearch'
  | 'settingsSearchKbd'
  | 'settingsSearchEmpty'
  | 'titleSettings'
  | 'titleCloseSettings'
  | 'settingsBy'
  | 'settingsDownloads'
  | 'settingsCapture'
  | 'settingsSavedData'
  | 'settingsTemplate'
  | 'settingsSubfolder'
  | 'settingsQuality'
  | 'settingsDirect'
  | 'settingsDirectHint'
  | 'settingsLanguage'
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
  | 'diagExport'
  | 'diagEventCount'
  | 'diagEventCountOne'
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
  | 'overlayFailed'
  // Settings pages.
  | 'ariaSetTabs'
  | 'tabGeneral'
  | 'tabLook'
  | 'tabKeys'
  | 'tabAdvanced'
  // General.
  | 'settingsQualityHint'
  | 'settingsSubfolderHint'
  | 'settingsInPage'
  | 'settingsInPageHint'
  | 'settingsLangTheme'
  | 'settingsLanguageHint'
  | 'langAuto'
  | 'settingsOrderHint'
  // Look.
  | 'settingsPanelLook'
  | 'settingsColumns'
  | 'settingsColumnsHint'
  | 'settingsBackdrop'
  | 'settingsBackdropHint'
  | 'backdropSolid'
  | 'backdropFrosted'
  | 'backdropGlass'
  | 'settingsCorners'
  | 'settingsCornersHint'
  | 'cornersSharp'
  | 'cornersSoft'
  | 'cornersRound'
  | 'settingsColour'
  | 'settingsColourHint'
  | 'swatchSolid'
  | 'swatchGradient'
  | 'swatchTint'
  // One per ACCENTS entry — the swatch's only label, so it is also its accessible name.
  | 'accent_brand'
  | 'accent_alert'
  | 'accent_sun'
  | 'accent_violet'
  | 'accent_indigo'
  | 'accent_pink'
  | 'accent_orange'
  | 'accent_forest'
  | 'accent_pine'
  | 'accent_slate'
  | 'accent_meta'
  | 'accent_messenger'
  | 'accent_story'
  | 'accent_grow'
  | 'accent_dusk'
  | 'accent_ember'
  | 'accent_teal'
  | 'accent_midnight'
  | 'accent_sunset'
  | 'accent_lime'
  | 'accent_copper'
  | 'accent_ice'
  | 'accent_steel'
  // One per PANEL_TINTS entry, same contract as the accents.
  | 'tint_slate'
  | 'tint_graphite'
  | 'tint_navy'
  | 'tint_plum'
  | 'tint_moss'
  | 'tint_sand'
  // The custom background, and the ways handing one over can fail.
  | 'settingsCustomBg'
  | 'settingsCustomBgHint'
  | 'settingsBgImage'
  | 'settingsBgPick'
  | 'settingsBgClear'
  | 'bgNone'
  | 'bgSet'
  | 'bgTooLarge'
  | 'bgNoRoom'
  | 'bgSuperseded'
  | 'bgUnreadable'
  // Advanced.
  | 'settingsFileName'
  | 'settingsPreview'
  | 'settingsVideosOnlyHint'
  | 'settingsMinResHint'
  | 'settingsConfirmClearHint'
  | 'settingsKeysEnabled'
  | 'settingsKeysEnabledHint'
  // Keyboard: the section, the capture state, and the three reasons a key is refused.
  | 'settingsKeys'
  | 'settingsKeysReset'
  | 'keysReset'
  | 'keyPressPrompt'
  | 'keyUnbound'
  | 'keyHint'
  | 'keyErrorSingle'
  | 'keyErrorPlain'
  | 'keyErrorTaken'
  // One label per bindable function, in KEY_ACTIONS order.
  | 'keyTogglePick'
  | 'keyDownloadCard'
  | 'keySelectAll'
  | 'keyDownloadPicks'
  | 'keyViewNow'
  | 'keyViewLibrary'
  | 'keyViewSaved'
  | 'keyCycleFilter'
  | 'keyOpenSettings'
  // The one shortcut that reaches past the panel; Chrome owns its combination.
  | 'settingsWhileBrowsing'
  | 'settingsGlobalKeyHint';

const MESSAGES: Record<Lang, Record<MsgKey, string>> = {
  en: {
    statusCapturing: 'Capturing',
    statusWatching: 'Watching',
    statusQueue: '{n} in queue',
    statusQueueOne: '1 in queue',
    viewNowPlaying: 'Now',
    viewLibrary: 'Library',
    viewSaved: 'Saved',
    ariaViews: 'Views',
    ariaFilters: 'Media filters',
    ariaGridDensity: 'Grid density',
    nowStatus: 'Now playing',
    nowEmptyTitle: 'Nothing playing yet',
    nowEmptyBody: 'Scroll to a reel, story or highlight on this tab. It shows up here the moment it starts.',
    nowEmptyPromise: 'nothing is fetched until you press play',
    nowEmptyToLibrary: 'See what is captured on this tab',
    videoQuality: 'Resolution',
    piecesInPost: '{n} pieces',
    piecesInPostOne: '1 piece',
    resAvailable: '{n} available',
    resAvailableOne: '1 available',
    resUpTo: 'up to {dims}',
    ariaResolutionList: 'Available resolutions',
    mediaAudioOk: 'Audio ok',
    mediaAudioMuted: 'No audio',
    savesToFolder: 'Saves to FaceScrap/',
    savesToRoot: 'Saves to Downloads/',
    saveAs: 'Save as…',
    nowSave: 'Save {kind}',
    downloadMerging: 'Merging…',
    downloadSaving: 'Saving…',
    downloadRetry: 'Retry',
    unavailable: 'Unavailable',
    libraryTitle: 'Library',
    savedTitle: 'Saved',
    onThisTab: '{n} on this tab',
    onThisTabOne: '1 on this tab',
    filesCount: '{n} files',
    filesCountOne: '1 file',
    openFolder: 'Open folder ↗',
    scrollForMore: 'Scroll for more ↓',
    filterAll: 'All',
    filterVideos: 'Videos',
    filterImages: 'Images',
    selectAll: 'Select all',
    deselectAll: 'Deselect all',
    selectItem: 'Select',
    cardPhoto: 'Photo',
    badgeOnDisk: 'On disk',
    badgeCaptureGone: 'Capture gone',
    titleRevealFolder: 'Show in folder',
    libraryEmptyTitle: 'Nothing captured yet',
    libraryEmptyBody: 'Open a Facebook tab and scroll — captures land here.',
    savedEmptyTitle: 'No downloads yet',
    savedEmptyBody: 'Downloads you make from this tab show up here.',
    selectedCount: '{n} selected',
    selectedCountOne: '1 selected',
    traySave: 'Save {n}',
    trayRemux: '{n} need remux',
    trayRemuxOne: '1 needs remux',
    bulkBusy: 'Saving {i}/{n}…',
    composeVideo: 'video',
    composeImage: 'image',
    composeAudio: 'audio',
    tagMayLackAudio: 'may lack audio',
    tagAudioTrack: 'audio track',
    tagFailed: 'failed',
    titleBlobUnavailable: 'This media is an MSE blob: and can\'t be saved.',
    titleSavedGone: 'Already downloaded. The capture is gone — replay it on this tab to re-enable downloading.',
    bannerDegraded:
      'This browser can\'t merge audio and video: HD saves as video only. Use Chrome or Edge to include audio.',
    settings: 'Settings',
    settingsAutosave: 'saved as you go',
    settingsSearch: 'Search settings',
    settingsSearchKbd: 'Ctrl K',
    settingsSearchEmpty: 'No setting matches that.',
    titleSettings: 'Settings',
    titleCloseSettings: 'Close settings',
    settingsBy: 'by Hydza',
    settingsDownloads: 'Downloads',
    settingsCapture: 'Capture',
    settingsSavedData: 'Saved data',
    settingsTemplate: 'Filename',
    settingsSubfolder: 'Save into FaceScrap/',
    settingsQuality: 'Quality',
    settingsDirect: 'Direct download',
    settingsDirectHint: 'Skips the audio merge · may arrive muted',
    settingsLanguage: 'Language',
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
    settingsDiagEnabled: 'Record diagnostics',
    settingsDiagHint: 'Reload Facebook to apply · nothing is uploaded',
    diagShow: 'Show counters',
    diagEmpty: 'Nothing recorded yet.',
    diagReset: 'Reset counters',
    diagExport: 'Export report',
    diagEventCount: '{n} events recorded',
    diagEventCountOne: '1 event recorded',
    clear: 'Clear',
    qualityHighest: 'Highest',
    qualityLowest: 'Lowest',
    qualityAsk: 'Ask',
    themeAuto: 'Auto',
    themeLight: 'Light',
    themeDark: 'Dark',
    orderNewest: 'Newest',
    orderOldest: 'Oldest',
    resNone: 'Off',
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
    ariaSetTabs: 'Settings pages',
    tabGeneral: 'General',
    tabLook: 'Look',
    tabKeys: 'Keys',
    tabAdvanced: 'Advanced',
    settingsQualityHint: 'Highest keeps the best representation the post offers.',
    settingsSubfolderHint: 'Keeps files out of the Downloads root',
    settingsInPage: 'Button on the video',
    settingsInPageHint: 'Adds nothing to the page when off',
    settingsLangTheme: 'Language & theme',
    settingsLanguageHint: 'Auto follows the browser.',
    langAuto: 'Auto',
    settingsOrderHint: 'Which end of the capture list comes first.',
    settingsPanelLook: 'Panel appearance',
    settingsColumns: 'Grid',
    settingsColumnsHint: 'Thumbnails per row · changes Library',
    settingsBackdrop: 'Background',
    settingsBackdropHint: 'Glass blurs what is behind the cards',
    backdropSolid: 'Solid',
    backdropFrosted: 'Frosted',
    backdropGlass: 'Glass',
    settingsCorners: 'Corners',
    settingsCornersHint: 'The radius every card and control shares',
    cornersSharp: 'Sharp',
    cornersSoft: 'Soft',
    cornersRound: 'Round',
    settingsColour: 'Colour',
    settingsColourHint: 'Accent for the controls, tint for the panel behind them',
    swatchSolid: 'Solid',
    swatchGradient: 'Gradient',
    swatchTint: 'Panel tint',
    accent_brand: 'Facebook blue',
    accent_alert: 'Notification red',
    accent_sun: 'Reaction yellow',
    accent_violet: 'Violet',
    accent_indigo: 'Indigo',
    accent_pink: 'Pink',
    accent_orange: 'Orange',
    accent_forest: 'Forest green',
    accent_pine: 'Pine',
    accent_slate: 'Slate',
    accent_meta: 'Meta blue',
    accent_messenger: 'Messenger',
    accent_story: 'Story',
    accent_grow: 'Grow green',
    accent_dusk: 'Dusk',
    accent_ember: 'Ember',
    accent_teal: 'Teal',
    accent_midnight: 'Midnight',
    accent_sunset: 'Sunset',
    accent_lime: 'Lime',
    accent_copper: 'Copper',
    accent_ice: 'Ice',
    accent_steel: 'Steel',
    tint_slate: 'Slate',
    tint_graphite: 'Graphite',
    tint_navy: 'Navy',
    tint_plum: 'Plum',
    tint_moss: 'Moss',
    tint_sand: 'Sand',
    settingsCustomBg: 'Your background',
    settingsCustomBgHint:
      'One image behind the panel, kept on this device and still here after you close the browser. It is resized before being stored, and never uploaded.',
    settingsBgImage: 'Image',
    settingsBgPick: 'Choose…',
    settingsBgClear: 'Remove',
    bgNone: 'None chosen',
    bgSet: 'In use',
    bgTooLarge: 'That image is too big. Try a smaller one.',
    bgNoRoom: 'No storage room left. Clear the captured list and try again.',
    bgSuperseded: 'Cancelled — the background changed while that one was being prepared.',
    bgUnreadable: "That file couldn't be read as an image.",
    settingsFileName: 'File name',
    settingsPreview: 'preview',
    settingsVideosOnlyHint: 'Hides photos · nothing is dropped',
    settingsMinResHint: 'An unmeasured video is never hidden',
    settingsConfirmClearHint: 'Asks first, so one click cannot empty the list.',
    settingsKeysEnabled: 'Keyboard control',
    settingsKeysEnabledHint: 'Turn off if the keys clash with an IME',
    settingsKeys: 'Keyboard shortcuts',
    settingsKeysReset: 'Restore default keys',
    keysReset: 'Reset',
    keyPressPrompt: 'Press a key…',
    keyUnbound: 'None',
    keyHint: 'Esc cancels a capture',
    keyErrorSingle: 'That needs to be a single character.',
    keyErrorPlain: 'Press the key on its own, without Ctrl or Alt.',
    keyErrorTaken: 'Already used by "{action}".',
    keyTogglePick: 'Toggle pick',
    keyDownloadCard: 'Download card',
    keySelectAll: 'Select all',
    keyDownloadPicks: 'Download picks',
    keyViewNow: 'Now playing',
    keyViewLibrary: 'Library',
    keyViewSaved: 'Saved',
    keyCycleFilter: 'Cycle filter',
    keyOpenSettings: 'Open settings',
    settingsWhileBrowsing: 'While browsing',
    settingsGlobalKeyHint:
      'Download without opening the panel: the command lives in manifest.json and is rebound at chrome://extensions/shortcuts.',
  },
  es: {
    statusCapturing: 'Capturando',
    statusWatching: 'Observando',
    statusQueue: '{n} en cola',
    statusQueueOne: '1 en cola',
    viewNowPlaying: 'Ahora',
    viewLibrary: 'Biblioteca',
    viewSaved: 'Guardados',
    ariaViews: 'Vistas',
    ariaFilters: 'Filtros de contenido',
    ariaGridDensity: 'Densidad de la rejilla',
    nowStatus: 'Reproduciendo ahora',
    nowEmptyTitle: 'Nada reproduciéndose aún',
    nowEmptyBody:
      'Ve a un reel, historia o destacada en esta pestaña. Aparecerá aquí en cuanto empiece.',
    nowEmptyPromise: 'no se descarga nada hasta que le das a reproducir',
    nowEmptyToLibrary: 'Ver lo capturado en esta pestaña',
    videoQuality: 'Resolución',
    piecesInPost: '{n} piezas',
    piecesInPostOne: '1 pieza',
    resAvailable: '{n} disponibles',
    resAvailableOne: '1 disponible',
    resUpTo: 'hasta {dims}',
    ariaResolutionList: 'Resoluciones disponibles',
    mediaAudioOk: 'Con audio',
    mediaAudioMuted: 'Sin audio',
    savesToFolder: 'Se guarda en FaceScrap/',
    savesToRoot: 'Se guarda en Descargas/',
    saveAs: 'Guardar como…',
    nowSave: 'Guardar {kind}',
    downloadMerging: 'Uniendo…',
    downloadSaving: 'Guardando…',
    downloadRetry: 'Reintentar',
    unavailable: 'No disponible',
    libraryTitle: 'Biblioteca',
    savedTitle: 'Guardados',
    onThisTab: '{n} en esta pestaña',
    onThisTabOne: '1 en esta pestaña',
    filesCount: '{n} archivos',
    filesCountOne: '1 archivo',
    openFolder: 'Abrir carpeta ↗',
    scrollForMore: 'Desplázate para ver más ↓',
    filterAll: 'Todo',
    filterVideos: 'Videos',
    filterImages: 'Imágenes',
    selectAll: 'Selec. todo',
    deselectAll: 'Quitar selección',
    selectItem: 'Seleccionar',
    cardPhoto: 'Foto',
    badgeOnDisk: 'En disco',
    badgeCaptureGone: 'Captura perdida',
    titleRevealFolder: 'Mostrar en la carpeta',
    libraryEmptyTitle: 'Nada capturado aún',
    libraryEmptyBody: 'Abre una pestaña de Facebook y desplázate: las capturas caen aquí.',
    savedEmptyTitle: 'Sin descargas aún',
    savedEmptyBody: 'Las descargas que hagas desde esta pestaña aparecerán aquí.',
    selectedCount: '{n} seleccionados',
    selectedCountOne: '1 seleccionado',
    traySave: 'Guardar {n}',
    trayRemux: '{n} necesitan unión',
    trayRemuxOne: '1 necesita unión',
    bulkBusy: 'Guardando {i}/{n}…',
    composeVideo: 'video',
    composeImage: 'imagen',
    composeAudio: 'audio',
    tagMayLackAudio: 'puede venir sin audio',
    tagAudioTrack: 'pista de audio',
    tagFailed: 'falló',
    titleBlobUnavailable: 'Este medio es un blob: de MSE y no puede guardarse.',
    titleSavedGone: 'Ya descargado. La captura ya no está: reprodúcelo en esta pestaña para reactivar la descarga.',
    bannerDegraded:
      'Este navegador no puede unir audio y video: los HD se descargan solo con imagen. Usa Chrome o Edge para incluir el audio.',
    settings: 'Ajustes',
    settingsAutosave: 'se guarda solo',
    settingsSearch: 'Buscar en ajustes',
    settingsSearchKbd: 'Ctrl K',
    settingsSearchEmpty: 'Ningún ajuste coincide.',
    titleSettings: 'Configuración',
    titleCloseSettings: 'Cerrar configuración',
    settingsBy: 'por Hydza',
    settingsDownloads: 'Descargas',
    settingsCapture: 'Captura',
    settingsSavedData: 'Datos guardados',
    settingsTemplate: 'Nombre de archivo',
    settingsSubfolder: 'Guardar en FaceScrap/',
    settingsQuality: 'Calidad',
    settingsDirect: 'Descarga directa',
    settingsDirectHint: 'Omite la unión de audio · puede llegar mudo',
    settingsLanguage: 'Idioma',
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
    settingsDiagEnabled: 'Registrar diagnóstico',
    settingsDiagHint: 'Recarga Facebook para aplicar · no se sube nada',
    diagShow: 'Ver contadores',
    diagEmpty: 'Nada registrado aún.',
    diagReset: 'Reiniciar contadores',
    diagExport: 'Exportar informe',
    diagEventCount: '{n} eventos registrados',
    diagEventCountOne: '1 evento registrado',
    clear: 'Vaciar',
    qualityHighest: 'Mayor',
    qualityLowest: 'Menor',
    qualityAsk: 'Preguntar',
    themeAuto: 'Automático',
    themeLight: 'Claro',
    themeDark: 'Oscuro',
    orderNewest: 'Nuevos',
    orderOldest: 'Antiguos',
    resNone: 'Sin',
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
    ariaSetTabs: 'Páginas de ajustes',
    tabGeneral: 'General',
    tabLook: 'Aspecto',
    tabKeys: 'Teclas',
    tabAdvanced: 'Avanzado',
    settingsQualityHint: 'Mayor guarda la mejor representación que ofrece la publicación.',
    settingsSubfolderHint: 'Los mantiene fuera de la raíz de Descargas',
    settingsInPage: 'Botón sobre el vídeo',
    settingsInPageHint: 'Apagado no añade nada a la página',
    settingsLangTheme: 'Idioma y tema',
    settingsLanguageHint: 'Auto sigue al navegador.',
    langAuto: 'Auto',
    settingsOrderHint: 'Por qué extremo de la lista empezar.',
    settingsPanelLook: 'Apariencia del panel',
    settingsColumns: 'Rejilla',
    settingsColumnsHint: 'Miniaturas por fila · cambia la Biblioteca',
    settingsBackdrop: 'Fondo',
    settingsBackdropHint: 'Cristal difumina lo que hay detrás de las tarjetas',
    backdropSolid: 'Sólido',
    backdropFrosted: 'Velado',
    backdropGlass: 'Cristal',
    settingsCorners: 'Esquinas',
    settingsCornersHint: 'El radio que comparten todas las tarjetas y controles',
    cornersSharp: 'Rectas',
    cornersSoft: 'Suaves',
    cornersRound: 'Redondas',
    settingsColour: 'Color',
    settingsColourHint: 'Acento para los controles, tinte para el panel detrás de ellos',
    swatchSolid: 'Sólidos',
    swatchGradient: 'Degradados',
    swatchTint: 'Tinte del panel',
    accent_brand: 'Azul de Facebook',
    accent_alert: 'Rojo de notificación',
    accent_sun: 'Amarillo de reacción',
    accent_violet: 'Violeta',
    accent_indigo: 'Índigo',
    accent_pink: 'Rosa',
    accent_orange: 'Naranja',
    accent_forest: 'Verde bosque',
    accent_pine: 'Pino',
    accent_slate: 'Pizarra',
    accent_meta: 'Azul de Meta',
    accent_messenger: 'Messenger',
    accent_story: 'Historia',
    accent_grow: 'Verde de Facebook',
    accent_dusk: 'Ocaso',
    accent_ember: 'Brasa',
    accent_teal: 'Turquesa',
    accent_midnight: 'Medianoche',
    accent_sunset: 'Atardecer',
    accent_lime: 'Lima',
    accent_copper: 'Cobre',
    accent_ice: 'Hielo',
    accent_steel: 'Acero',
    tint_slate: 'Pizarra',
    tint_graphite: 'Grafito',
    tint_navy: 'Marino',
    tint_plum: 'Ciruela',
    tint_moss: 'Musgo',
    tint_sand: 'Arena',
    settingsCustomBg: 'Tu fondo',
    settingsCustomBgHint:
      'Una imagen detrás del panel, guardada en este dispositivo y ahí sigue cuando cierras el navegador. Se redimensiona antes de guardarse y nunca se sube.',
    settingsBgImage: 'Imagen',
    settingsBgPick: 'Elegir…',
    settingsBgClear: 'Quitar',
    bgNone: 'Ninguna elegida',
    bgSet: 'En uso',
    bgTooLarge: 'Esa imagen es demasiado grande. Prueba una más pequeña.',
    bgNoRoom: 'No queda espacio de almacenamiento. Vacía la lista capturada e inténtalo de nuevo.',
    bgSuperseded: 'Cancelado: el fondo cambió mientras se preparaba esa imagen.',
    bgUnreadable: 'No se pudo leer ese archivo como imagen.',
    settingsFileName: 'Nombre de archivo',
    settingsPreview: 'vista previa',
    settingsVideosOnlyHint: 'Oculta las fotos · no se descarta nada',
    settingsMinResHint: 'Un vídeo sin medir nunca se oculta',
    settingsConfirmClearHint: 'Pregunta primero, así un clic no puede vaciar la lista.',
    settingsKeysEnabled: 'Control por teclado',
    settingsKeysEnabledHint: 'Desactívalo si las teclas chocan con un IME',
    settingsKeys: 'Atajos de teclado',
    settingsKeysReset: 'Restaurar teclas por defecto',
    keysReset: 'Restaurar',
    keyPressPrompt: 'Pulsa una tecla…',
    keyUnbound: 'Ninguna',
    keyHint: 'Esc cancela la captura',
    keyErrorSingle: 'Tiene que ser un solo carácter.',
    keyErrorPlain: 'Pulsa la tecla sola, sin Ctrl ni Alt.',
    keyErrorTaken: 'Ya la usa «{action}».',
    keyTogglePick: 'Alternar selección',
    keyDownloadCard: 'Descargar tarjeta',
    keySelectAll: 'Seleccionar todo',
    keyDownloadPicks: 'Descargar selección',
    keyViewNow: 'Reproduciendo',
    keyViewLibrary: 'Biblioteca',
    keyViewSaved: 'Guardados',
    keyCycleFilter: 'Cambiar filtro',
    keyOpenSettings: 'Abrir ajustes',
    settingsWhileBrowsing: 'Mientras navegas',
    settingsGlobalKeyHint:
      'Descarga sin abrir el panel: el comando vive en manifest.json y se reasigna en chrome://extensions/shortcuts.',
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

async function loadLang(): Promise<Lang> {
  const stored = (await chrome.storage.local.get(LANG_KEY))[LANG_KEY];
  return stored === 'es' ? 'es' : 'en';
}

export async function saveLang(lang: Lang): Promise<void> {
  await chrome.storage.local.set({ [LANG_KEY]: lang });
}

/** The language to use: the browser's when "follow browser language" is on,
 *  otherwise the manually-saved choice. Shared so the in-page download overlay
 *  localises exactly like the panel. */
export async function resolveLang(followBrowserLang: boolean): Promise<Lang> {
  if (followBrowserLang) {
    return (navigator.language || 'en').toLowerCase().startsWith('es') ? 'es' : 'en';
  }
  return loadLang();
}
