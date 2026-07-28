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
  | 'overlayFailed'
  // Settings pages.
  | 'ariaSetTabs'
  | 'tabGeneral'
  | 'tabAppearance'
  | 'tabShortcuts'
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
  // Appearance.
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
  | 'settingsAccent'
  | 'settingsAccentHint'
  // One per ACCENTS entry — the swatch's only label, so it is also its accessible name.
  | 'accent_brand'
  | 'accent_alert'
  | 'accent_sun'
  | 'accent_meta'
  | 'accent_messenger'
  | 'accent_story'
  | 'accent_grow'
  // The custom background, and the two ways handing one over can fail.
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
  | 'settingsKeysHint'
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
  | 'settingsGlobalKey'
  | 'settingsGlobalKeyHint';

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
    settingsAutosave: 'Four short pages. Changes save as you make them.',
    titleSettings: 'Settings',
    titleCloseSettings: 'Close settings',
    settingsDownloads: 'Downloads',
    settingsCapture: 'Capture',
    settingsSavedData: 'Saved data',
    settingsTemplate: 'Filename',
    settingsSubfolder: 'Save in "FaceScrap/" subfolder',
    settingsQuality: 'Default quality',
    settingsDirect: 'Direct download',
    settingsDirectHint: 'May skip audio merge',
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
    ariaSetTabs: 'Settings pages',
    tabGeneral: 'General',
    tabAppearance: 'Appearance',
    tabShortcuts: 'Shortcuts',
    tabAdvanced: 'Advanced',
    settingsQualityHint: 'Highest keeps the best representation the post offers.',
    settingsSubfolderHint: 'A "FaceScrap/" subfolder keeps them out of the Downloads root.',
    settingsInPage: 'Button on the video',
    settingsInPageHint:
      'A download button on the reel, story or photo you are watching. Off adds nothing to the page.',
    settingsLangTheme: 'Language & theme',
    settingsLanguageHint: 'Auto follows the browser.',
    langAuto: 'Auto',
    settingsOrderHint: 'Which end of the capture list comes first.',
    settingsPanelLook: 'Panel appearance',
    settingsColumns: 'Grid',
    settingsColumnsHint: 'Thumbnails per row. Fewer columns, larger previews.',
    settingsBackdrop: 'Background',
    settingsBackdropHint: 'Let your image show through. Glass blurs what is behind the cards.',
    backdropSolid: 'Solid',
    backdropFrosted: 'Frosted',
    backdropGlass: 'Glass',
    settingsCorners: 'Corners',
    settingsCornersHint: 'The radius every card and control shares.',
    cornersSharp: 'Sharp',
    cornersSoft: 'Soft',
    cornersRound: 'Round',
    settingsAccent: 'Accent',
    settingsAccentHint: 'Selection, progress and the primary button.',
    accent_brand: 'Facebook blue',
    accent_alert: 'Notification red',
    accent_sun: 'Reaction yellow',
    accent_meta: 'Meta blue',
    accent_messenger: 'Messenger',
    accent_story: 'Story',
    accent_grow: 'Green',
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
    settingsVideosOnlyHint: 'Hides photos from the Library. Nothing is dropped.',
    settingsMinResHint: 'Hides videos below it. An unmeasured video is never hidden.',
    settingsConfirmClearHint: 'Asks first, so one click cannot empty the list.',
    settingsKeysEnabled: 'Keyboard control',
    settingsKeysEnabledHint: 'Turn off if the keys clash with an IME or another extension.',
    settingsKeys: 'Keyboard shortcuts',
    settingsKeysHint:
      'Arrows move between cards. These keys work while the panel has focus, so Facebook never sees them.',
    settingsKeysReset: 'Restore default keys',
    keysReset: 'Reset',
    keyPressPrompt: 'Press a key…',
    keyUnbound: 'None',
    keyHint: 'Click, then press a key. Backspace clears it, Esc cancels.',
    keyErrorSingle: 'That needs to be a single character.',
    keyErrorPlain: 'Press the key on its own, without Ctrl or Alt.',
    keyErrorTaken: 'Already used by "{action}".',
    keyTogglePick: 'Select the card',
    keyDownloadCard: 'Download the card',
    keySelectAll: 'Select all',
    keyDownloadPicks: 'Download selection',
    keyViewNow: 'Go to Now',
    keyViewLibrary: 'Go to Library',
    keyViewSaved: 'Go to Saved',
    keyCycleFilter: 'Next media filter',
    keyOpenSettings: 'Open Settings',
    settingsGlobalKey: 'Download while browsing',
    settingsGlobalKeyHint: 'Set it in chrome://extensions/shortcuts',
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
    settingsAutosave: 'Cuatro páginas cortas. Los cambios se guardan solos.',
    titleSettings: 'Configuración',
    titleCloseSettings: 'Cerrar configuración',
    settingsDownloads: 'Descargas',
    settingsCapture: 'Captura',
    settingsSavedData: 'Datos guardados',
    settingsTemplate: 'Nombre de archivo',
    settingsSubfolder: 'Subcarpeta «FaceScrap/»',
    settingsQuality: 'Calidad por defecto',
    settingsDirect: 'Descarga directa',
    settingsDirectHint: 'Puede omitir la unión de audio',
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
    ariaSetTabs: 'Páginas de ajustes',
    tabGeneral: 'General',
    tabAppearance: 'Apariencia',
    tabShortcuts: 'Atajos',
    tabAdvanced: 'Avanzado',
    settingsQualityHint: 'Mayor guarda la mejor representación que ofrece la publicación.',
    settingsSubfolderHint: 'Una subcarpeta «FaceScrap/» los mantiene fuera de la raíz de Descargas.',
    settingsInPage: 'Botón sobre el vídeo',
    settingsInPageHint:
      'Un botón de descarga en el reel, la historia o la foto que estás viendo. Apagado no añade nada a la página.',
    settingsLangTheme: 'Idioma y tema',
    settingsLanguageHint: 'Auto sigue al navegador.',
    langAuto: 'Auto',
    settingsOrderHint: 'Por qué extremo de la lista empezar.',
    settingsPanelLook: 'Apariencia del panel',
    settingsColumns: 'Rejilla',
    settingsColumnsHint: 'Miniaturas por fila. Menos columnas, vistas más grandes.',
    settingsBackdrop: 'Fondo',
    settingsBackdropHint: 'Deja ver tu imagen. Cristal difumina lo que hay detrás de las tarjetas.',
    backdropSolid: 'Sólido',
    backdropFrosted: 'Velado',
    backdropGlass: 'Cristal',
    settingsCorners: 'Esquinas',
    settingsCornersHint: 'El radio que comparten todas las tarjetas y controles.',
    cornersSharp: 'Rectas',
    cornersSoft: 'Suaves',
    cornersRound: 'Redondas',
    settingsAccent: 'Acento',
    settingsAccentHint: 'Selección, progreso y el botón principal.',
    accent_brand: 'Azul de Facebook',
    accent_alert: 'Rojo de notificación',
    accent_sun: 'Amarillo de reacción',
    accent_meta: 'Azul de Meta',
    accent_messenger: 'Messenger',
    accent_story: 'Historia',
    accent_grow: 'Verde',
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
    settingsVideosOnlyHint: 'Oculta las fotos de la Biblioteca. No se descarta nada.',
    settingsMinResHint: 'Oculta los vídeos por debajo. Un vídeo sin medir nunca se oculta.',
    settingsConfirmClearHint: 'Pregunta primero, así un clic no puede vaciar la lista.',
    settingsKeysEnabled: 'Control por teclado',
    settingsKeysEnabledHint: 'Desactívalo si las teclas chocan con un IME u otra extensión.',
    settingsKeys: 'Atajos de teclado',
    settingsKeysHint:
      'Las flechas mueven entre tarjetas. Estas teclas funcionan con el panel enfocado, así que Facebook nunca las ve.',
    settingsKeysReset: 'Restaurar teclas por defecto',
    keysReset: 'Restaurar',
    keyPressPrompt: 'Pulsa una tecla…',
    keyUnbound: 'Ninguna',
    keyHint: 'Haz clic y pulsa una tecla. Retroceso la quita, Esc cancela.',
    keyErrorSingle: 'Tiene que ser un solo carácter.',
    keyErrorPlain: 'Pulsa la tecla sola, sin Ctrl ni Alt.',
    keyErrorTaken: 'Ya la usa «{action}».',
    keyTogglePick: 'Seleccionar la tarjeta',
    keyDownloadCard: 'Descargar la tarjeta',
    keySelectAll: 'Seleccionar todo',
    keyDownloadPicks: 'Descargar la selección',
    keyViewNow: 'Ir a Ahora',
    keyViewLibrary: 'Ir a Biblioteca',
    keyViewSaved: 'Ir a Guardados',
    keyCycleFilter: 'Siguiente filtro de medios',
    keyOpenSettings: 'Abrir Ajustes',
    settingsGlobalKey: 'Descargar mientras navegas',
    settingsGlobalKeyHint: 'Configúrala en chrome://extensions/shortcuts',
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
