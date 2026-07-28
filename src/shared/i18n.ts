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
    nowEmptyBody: 'Scroll to a reel, story or highlight on this tab. It appears here when playback starts.',
    nowEmptyPromise: 'Nothing is requested from the network until playback starts.',
    nowEmptyToLibrary: 'View captures on this tab',
    videoQuality: 'Resolution',
    piecesInPost: '{n} items',
    piecesInPostOne: '1 item',
    resAvailable: '{n} available',
    resUpTo: 'up to {dims}',
    ariaResolutionList: 'Available resolutions',
    mediaAudioOk: 'Has audio',
    mediaAudioMuted: 'No audio',
    savesToFolder: 'Saves to FaceScrap/',
    savesToRoot: 'Saves to Downloads/',
    saveAs: 'Save as…',
    nowSave: 'Save {kind}',
    downloadMerging: 'Merging tracks…',
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
    badgeCaptureGone: 'Capture expired',
    titleRevealFolder: 'Show in folder',
    libraryEmptyTitle: 'Nothing captured yet',
    libraryEmptyBody: 'Open a Facebook tab and scroll. Captures appear here.',
    savedEmptyTitle: 'No downloads yet',
    savedEmptyBody: 'Downloads made from this tab appear here.',
    selectedCount: '{n} selected',
    selectedCountOne: '1 selected',
    traySave: 'Save {n}',
    trayRemux: '{n} need merging',
    trayRemuxOne: '1 needs merging',
    bulkBusy: 'Saving {i}/{n}…',
    composeVideo: 'video',
    composeImage: 'image',
    composeAudio: 'audio',
    tagMayLackAudio: 'may lack audio',
    tagAudioTrack: 'audio track',
    tagFailed: 'failed',
    titleBlobUnavailable: 'This media is an MSE blob: URL and cannot be saved.',
    titleSavedGone: 'Already downloaded. The capture has expired. Replay it on this tab to download it again.',
    bannerDegraded:
      'This browser cannot merge audio and video: an HD download arrives with no audio. Use Chrome or Edge to include it.',
    settings: 'Settings',
    settingsAutosave: 'saves automatically',
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
    settingsDirectHint: 'Skips the audio merge · the file may have no audio',
    settingsLanguage: 'Language',
    settingsTheme: 'Theme',
    settingsThemeHint: 'Follows Facebook, then your device',
    settingsOrder: 'List order',
    settingsVideosOnly: 'Videos only',
    settingsMinRes: 'Minimum resolution',
    settingsMaxItems: 'Maximum saved items',
    settingsConfirmClear: 'Confirm before clearing',
    settingsClearList: 'Clear capture list',
    settingsClearHint: 'Empties Library only · Saved is not affected',
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
    // The option that applies no minimum. "Off" read as a broken switch next to three
    // resolutions; this names what the setting DOES at that value.
    resNone: 'Any',
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
    errNoAudioTrack: 'This video has no audio track.',
    errMergeTimedOut: 'The merge timed out. Retry the download.',
    errMergeFailed: 'The merge failed. Retry the download.',
    errDownloadFailed: 'The download failed. Retry it.',
    errInvalidTab: 'No valid tab for this download.',
    fatalStartup:
      'FaceScrap could not start on this browser ({message}). It needs a Chromium browser with the storage, tabs and side-panel APIs. Use Chrome or Edge.',
    fatalStartupVersion: ' [v{version}]',
    overlayDownload: 'Download',
    overlayPickQuality: 'Choose a resolution',
    overlayWorking: 'Saving…',
    overlayDone: 'Saved',
    overlayFailed: 'Download failed',
    ariaSetTabs: 'Settings pages',
    tabGeneral: 'General',
    tabLook: 'Look',
    tabKeys: 'Keys',
    tabAdvanced: 'Advanced',
    settingsQualityHint: 'Highest selects the best representation the post offers',
    settingsSubfolderHint: 'Keeps files out of the Downloads root',
    settingsInPage: 'Button on the video',
    settingsInPageHint: 'When off, nothing is added to the page',
    settingsLangTheme: 'Language & theme',
    settingsLanguageHint: 'Auto follows the browser language',
    langAuto: 'Auto',
    settingsOrderHint: 'Which end of the capture list appears first',
    settingsPanelLook: 'Panel appearance',
    settingsColumns: 'Grid',
    settingsColumnsHint: 'Thumbnails per row in Library',
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
    settingsColourHint: 'Accent for the controls, tint for the panel surface',
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
    accent_grow: 'Facebook green',
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
    settingsCustomBg: 'Background image',
    settingsCustomBgHint:
      'One image behind the panel. It is kept on this device, resized before storage, and never uploaded.',
    settingsBgImage: 'Image',
    settingsBgPick: 'Choose…',
    settingsBgClear: 'Remove',
    bgNone: 'None chosen',
    bgSet: 'In use',
    bgTooLarge: 'That image exceeds the size limit. Choose a smaller image.',
    bgNoRoom: 'Storage is full. Clear the captured list and try again.',
    bgSuperseded: 'Cancelled: the background image changed while that one was being prepared.',
    bgUnreadable: 'That file could not be read as an image.',
    settingsFileName: 'Filename',
    settingsPreview: 'preview',
    settingsVideosOnlyHint: 'Hides images · nothing is deleted',
    settingsMinResHint: 'Hides videos below this · unknown resolutions are kept',
    settingsConfirmClearHint: 'A confirmation stops one click from emptying the list',
    settingsKeysEnabled: 'Keyboard control',
    settingsKeysEnabledHint: 'Turn off if the keys conflict with an IME',
    settingsKeys: 'Keyboard shortcuts',
    settingsKeysReset: 'Restore default keys',
    keysReset: 'Reset',
    keyPressPrompt: 'Press a key…',
    keyUnbound: 'None',
    keyHint: 'Esc cancels the key prompt',
    keyErrorSingle: 'The shortcut must be a single character.',
    keyErrorPlain: 'Press the key on its own, without Ctrl or Alt.',
    keyErrorTaken: 'That key is already used by "{action}".',
    keyTogglePick: 'Toggle selection',
    keyDownloadCard: 'Download card',
    keySelectAll: 'Select all',
    keyDownloadPicks: 'Download selection',
    keyViewNow: 'Now playing',
    keyViewLibrary: 'Library',
    keyViewSaved: 'Saved',
    keyCycleFilter: 'Cycle filter',
    keyOpenSettings: 'Open settings',
    settingsWhileBrowsing: 'While browsing',
    settingsGlobalKeyHint:
      'Download without opening the panel. The command is declared in manifest.json and is rebound at chrome://extensions/shortcuts.',
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
    ariaGridDensity: 'Densidad de la cuadrícula',
    nowStatus: 'Reproduciendo ahora',
    nowEmptyTitle: 'Nada en reproducción',
    nowEmptyBody:
      'Ve a un reel, historia o destacada en esta pestaña. Aparece aquí cuando empieza la reproducción.',
    nowEmptyPromise: 'No se solicita nada a la red hasta que empieza la reproducción.',
    nowEmptyToLibrary: 'Ver capturas de esta pestaña',
    videoQuality: 'Resolución',
    piecesInPost: '{n} elementos',
    piecesInPostOne: '1 elemento',
    resAvailable: '{n} disponibles',
    resUpTo: 'hasta {dims}',
    ariaResolutionList: 'Resoluciones disponibles',
    mediaAudioOk: 'Con audio',
    mediaAudioMuted: 'Sin audio',
    savesToFolder: 'Se guarda en FaceScrap/',
    savesToRoot: 'Se guarda en Descargas/',
    saveAs: 'Guardar como…',
    nowSave: 'Guardar {kind}',
    downloadMerging: 'Uniendo pistas…',
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
    selectAll: 'Seleccionar todo',
    deselectAll: 'Quitar selección',
    selectItem: 'Seleccionar',
    cardPhoto: 'Foto',
    badgeOnDisk: 'En disco',
    badgeCaptureGone: 'Captura expirada',
    titleRevealFolder: 'Mostrar en la carpeta',
    libraryEmptyTitle: 'Nada capturado aún',
    libraryEmptyBody: 'Abre una pestaña de Facebook y desplázate. Las capturas aparecen aquí.',
    savedEmptyTitle: 'Sin descargas aún',
    savedEmptyBody: 'Las descargas hechas desde esta pestaña aparecen aquí.',
    selectedCount: '{n} seleccionados',
    selectedCountOne: '1 seleccionado',
    traySave: 'Guardar {n}',
    trayRemux: '{n} necesitan unión',
    trayRemuxOne: '1 necesita unión',
    bulkBusy: 'Guardando {i}/{n}…',
    composeVideo: 'video',
    composeImage: 'imagen',
    composeAudio: 'audio',
    tagMayLackAudio: 'puede quedar sin audio',
    tagAudioTrack: 'pista de audio',
    tagFailed: 'falló',
    titleBlobUnavailable: 'Este medio es una URL blob: de MSE y no puede guardarse.',
    titleSavedGone: 'Ya descargado. La captura expiró. Reprodúcelo en esta pestaña para descargarlo de nuevo.',
    bannerDegraded:
      'Este navegador no puede unir audio y video: las descargas HD quedan sin audio. Usa Chrome o Edge para incluirlo.',
    settings: 'Ajustes',
    settingsAutosave: 'guardado automático',
    settingsSearch: 'Buscar en ajustes',
    settingsSearchKbd: 'Ctrl K',
    settingsSearchEmpty: 'Ningún ajuste coincide.',
    titleSettings: 'Ajustes',
    titleCloseSettings: 'Cerrar ajustes',
    settingsBy: 'por Hydza',
    settingsDownloads: 'Descargas',
    settingsCapture: 'Captura',
    settingsSavedData: 'Datos guardados',
    settingsTemplate: 'Nombre de archivo',
    settingsSubfolder: 'Guardar en FaceScrap/',
    settingsQuality: 'Calidad',
    settingsDirect: 'Descarga directa',
    settingsDirectHint: 'Omite la unión de pistas · el archivo puede quedar sin audio',
    settingsLanguage: 'Idioma',
    settingsTheme: 'Tema',
    settingsThemeHint: 'Sigue Facebook y luego tu dispositivo',
    settingsOrder: 'Orden de la lista',
    settingsVideosOnly: 'Solo videos',
    settingsMinRes: 'Resolución mínima',
    settingsMaxItems: 'Máximo de elementos guardados',
    settingsConfirmClear: 'Confirmar antes de vaciar',
    settingsClearList: 'Vaciar la lista de capturas',
    settingsClearHint: 'Vacía solo Biblioteca · Guardados no se modifica',
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
    resNone: 'Cualquiera',
    maxUnlimited: 'Sin límite',
    confirmClearPrompt: '¿Vaciar todos los elementos capturados de esta pestaña?',
    sourceReel: 'Reel',
    sourceStory: 'Historia',
    sourceHighlight: 'Destacada',
    sourceVideo: 'Video',
    sourcePage: 'Imagen',
    kindVideo: 'Video',
    kindImage: 'Imagen',
    kindAudio: 'Audio',
    errNoAudioTrack: 'Este video no tiene pista de audio.',
    errMergeTimedOut: 'La unión de pistas tardó demasiado. Vuelve a intentar la descarga.',
    errMergeFailed: 'Falló la unión de pistas. Vuelve a intentar la descarga.',
    errDownloadFailed: 'Falló la descarga. Vuelve a intentarla.',
    errInvalidTab: 'No hay una pestaña válida para esta descarga.',
    fatalStartup:
      'FaceScrap no pudo iniciarse en este navegador ({message}). Necesita un navegador Chromium con las APIs de storage, tabs y panel lateral. Usa Chrome o Edge.',
    fatalStartupVersion: ' [v{version}]',
    overlayDownload: 'Descargar',
    overlayPickQuality: 'Elige una resolución',
    overlayWorking: 'Guardando…',
    overlayDone: 'Guardado',
    overlayFailed: 'Falló la descarga',
    ariaSetTabs: 'Páginas de ajustes',
    tabGeneral: 'General',
    tabLook: 'Aspecto',
    tabKeys: 'Teclas',
    tabAdvanced: 'Avanzado',
    settingsQualityHint: 'Mayor elige la mejor representación que ofrece la publicación',
    settingsSubfolderHint: 'Mantiene los archivos fuera de la raíz de Descargas',
    settingsInPage: 'Botón sobre el video',
    settingsInPageHint: 'Desactivado no modifica la página',
    settingsLangTheme: 'Idioma y tema',
    settingsLanguageHint: 'Auto sigue el idioma del navegador',
    langAuto: 'Auto',
    settingsOrderHint: 'Qué extremo de la lista se muestra primero',
    settingsPanelLook: 'Apariencia del panel',
    settingsColumns: 'Cuadrícula',
    settingsColumnsHint: 'Miniaturas por fila en Biblioteca',
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
    settingsColourHint: 'Acento para los controles, tinte para la superficie del panel',
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
    settingsCustomBg: 'Imagen de fondo',
    settingsCustomBgHint:
      'Una imagen detrás del panel. Se conserva en este dispositivo al cerrar el navegador, se redimensiona antes de guardarse y nunca se sube.',
    settingsBgImage: 'Imagen',
    settingsBgPick: 'Elegir…',
    settingsBgClear: 'Quitar',
    bgNone: 'Ninguna elegida',
    bgSet: 'En uso',
    bgTooLarge: 'Esa imagen supera el límite de tamaño. Elige una imagen más pequeña.',
    bgNoRoom: 'El almacenamiento está lleno. Vacía la lista de capturas e inténtalo de nuevo.',
    bgSuperseded: 'Cancelado: la imagen de fondo cambió mientras esta se preparaba.',
    bgUnreadable: 'No se pudo leer ese archivo como imagen.',
    settingsFileName: 'Nombre de archivo',
    settingsPreview: 'vista previa',
    settingsVideosOnlyHint: 'Oculta las imágenes · no se elimina nada',
    settingsMinResHint: 'Oculta los videos por debajo · conserva los de resolución desconocida',
    settingsConfirmClearHint: 'Una confirmación evita que un clic vacíe la lista',
    settingsKeysEnabled: 'Control por teclado',
    settingsKeysEnabledHint: 'Desactívalo si las teclas interfieren con un IME',
    settingsKeys: 'Atajos de teclado',
    settingsKeysReset: 'Restaurar teclas por defecto',
    keysReset: 'Restaurar',
    keyPressPrompt: 'Presiona una tecla…',
    keyUnbound: 'Ninguna',
    keyHint: 'Esc cancela la asignación de la tecla',
    keyErrorSingle: 'El atajo tiene que ser un solo carácter.',
    keyErrorPlain: 'Presiona la tecla sola, sin Ctrl ni Alt.',
    keyErrorTaken: 'Esa tecla ya la usa «{action}».',
    keyTogglePick: 'Alternar selección',
    keyDownloadCard: 'Descargar tarjeta',
    keySelectAll: 'Seleccionar todo',
    keyDownloadPicks: 'Descargar selección',
    keyViewNow: 'Reproduciendo ahora',
    keyViewLibrary: 'Biblioteca',
    keyViewSaved: 'Guardados',
    keyCycleFilter: 'Cambiar filtro',
    keyOpenSettings: 'Abrir ajustes',
    settingsWhileBrowsing: 'Mientras navegas',
    settingsGlobalKeyHint:
      'Descarga sin abrir el panel. El comando se declara en manifest.json y se reasigna en chrome://extensions/shortcuts.',
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
