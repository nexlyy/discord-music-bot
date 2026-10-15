/** Плейлист, из которого добавлен трек. WeakMap по объекту трека: отложенные треки теряют userData при подгрузке. */
export const playlistMeta = new WeakMap<object, { playlistName: string; playlistUrl: string | null }>();
