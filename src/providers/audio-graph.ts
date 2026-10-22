let audioGraph: Compressor | undefined;

export const setAudioGraph = (graph: Compressor) => {
  audioGraph = graph;
};

/**
 * The player's audio graph, or `undefined` before the player API is ready.
 * Lets plugins enabled mid-playback attach without waiting for `peard:audio-can-play`.
 */
export const getAudioGraph = () => audioGraph;
