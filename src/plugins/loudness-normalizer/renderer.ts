import { EXPONENT } from '@/plugins/exponential-volume';
import { getAudioGraph } from '@/providers/audio-graph';
import { createRenderer, LoggerPrefix } from '@/utils';

import type { LoudnessNormalizerPluginConfig } from './index';
import type { AudioConfig } from '@/types/get-player-response';
import type { MusicPlayer } from '@/types/music-player';
import type { VideoDataChanged } from '@/types/video-data-changed';

// Safety limiter, only active above LIMITER_THRESHOLD_DB.
// Chromium's DynamicsCompressorNode adds an automatic makeup gain of
// 0.6 * (gain reduction at 0 dBFS); undo it so audio below the threshold passes unchanged.
const LIMITER_THRESHOLD_DB = -3;
const LIMITER_RATIO = 20;
const LIMITER_MAKEUP_DB =
  (0.6 * -LIMITER_THRESHOLD_DB * (LIMITER_RATIO - 1)) / LIMITER_RATIO;

// Time constant for gain changes (reaches the new value in ~50 ms)
const GAIN_TIME_CONSTANT = 0.015;

const dbToGain = (db: number) => 10 ** (db / 20);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const getTrackLoudness = (audioConfig?: AudioConfig) => {
  if (!audioConfig) return undefined;
  const {
    trackAbsoluteLoudnessLkfs: lkfs,
    loudnessDb,
    loudnessTargetLkfs,
  } = audioConfig;
  if (isFiniteNumber(lkfs)) return lkfs;
  // loudnessDb is the loudness relative to the player's target
  if (isFiniteNumber(loudnessDb) && isFiniteNumber(loudnessTargetLkfs)) {
    return loudnessDb + loudnessTargetLkfs;
  }
  return undefined;
};

// Attenuation the player itself applies through the media element volume (it never boosts)
const getPlayerAttenuationDb = (audioConfig: AudioConfig) => {
  const { trackAbsoluteLoudnessLkfs: lkfs, loudnessDb } = audioConfig;
  if (isFiniteNumber(lkfs)) {
    const target = audioConfig.loudnessTargetLkfs ?? Infinity;
    return Math.min(target - lkfs, 0);
  }
  if (isFiniteNumber(loudnessDb)) return Math.min(-loudnessDb, 0);
  return 0;
};

// exponential-volume replaces the volume setter with volume ** EXPONENT,
// which also raises the player's normalization multiplier to that power
const getVolumeExponent = () => {
  // oxlint-disable-next-line typescript/unbound-method
  const getter = Object.getOwnPropertyDescriptor(
    HTMLMediaElement.prototype,
    'volume',
  )?.get;
  const isNative =
    !!getter &&
    Function.prototype.toString.call(getter).includes('[native code]');
  return isNative ? 1 : EXPONENT;
};

export const renderer = createRenderer<
  {
    config?: LoudnessNormalizerPluginConfig;
    api?: MusicPlayer;
    graph?: Compressor;
    gainNode?: GainNode;
    limiterNode?: DynamicsCompressorNode;
    makeupNode?: GainNode;
    attach: (graph: Compressor) => void;
    detach: () => void;
    connectOutput: () => void;
    updateGain: () => void;
    audioCanPlayHandler: (event: CustomEvent<Compressor>) => void;
    videoDataChangeHandler: (event: CustomEvent<VideoDataChanged>) => void;
  },
  LoudnessNormalizerPluginConfig
>({
  attach(graph) {
    // peard:audio-can-play sends a new detail object for every track
    if (this.graph?.audioOutput === graph.audioOutput) return;
    this.detach();

    const { audioContext, audioOutput } = graph;
    this.gainNode = audioContext.createGain();

    this.limiterNode = audioContext.createDynamicsCompressor();
    this.limiterNode.threshold.value = LIMITER_THRESHOLD_DB;
    this.limiterNode.knee.value = 0;
    this.limiterNode.ratio.value = LIMITER_RATIO;
    this.limiterNode.attack.value = 0;
    this.limiterNode.release.value = 0.1;

    this.makeupNode = audioContext.createGain();
    this.makeupNode.gain.value = dbToGain(-LIMITER_MAKEUP_DB);
    this.limiterNode.connect(this.makeupNode);
    this.makeupNode.connect(audioContext.destination);

    try {
      audioOutput.disconnect(audioContext.destination);
    } catch {}
    audioOutput.connect(this.gainNode);

    this.graph = graph;
    this.connectOutput();
    this.updateGain();
  },

  detach() {
    const graph = this.graph;
    if (!graph) return;

    const { audioContext, audioOutput } = graph;
    try {
      audioOutput.disconnect(this.gainNode!);
    } catch {}
    this.gainNode?.disconnect();
    this.limiterNode?.disconnect();
    this.makeupNode?.disconnect();
    audioOutput.connect(audioContext.destination);

    this.graph = undefined;
    this.gainNode = undefined;
    this.limiterNode = undefined;
    this.makeupNode = undefined;
  },

  connectOutput() {
    if (!this.graph || !this.gainNode) return;

    this.gainNode.disconnect();
    this.gainNode.connect(
      this.config?.limiter
        ? this.limiterNode!
        : this.graph.audioContext.destination,
    );
  },

  updateGain() {
    if (!this.graph || !this.gainNode || !this.config) return;

    const audioConfig =
      this.api?.getPlayerResponse()?.playerConfig?.audioConfig;
    const loudness = getTrackLoudness(audioConfig);

    let gainDb = 0;
    if (audioConfig && loudness !== undefined) {
      const wantedDb = Math.min(
        this.config.targetLkfs - loudness,
        this.config.maxBoostDb,
      );
      const playerDb =
        getPlayerAttenuationDb(audioConfig) * getVolumeExponent();
      gainDb = wantedDb - playerDb;
    }

    this.gainNode.gain.setTargetAtTime(
      dbToGain(gainDb),
      this.graph.audioContext.currentTime,
      GAIN_TIME_CONSTANT,
    );

    if (window.electronIs.dev()) {
      console.log(
        LoggerPrefix,
        `[loudness-normalizer] loudness: ${loudness ?? 'unknown'} LKFS, gain: ${gainDb.toFixed(2)} dB`,
      );
    }
  },

  audioCanPlayHandler({ detail }) {
    this.attach(detail);
  },

  videoDataChangeHandler({ detail: { name } }) {
    // 'dataloaded' arrives with the new player response, before playback starts
    if (name === 'dataloaded' || name === 'dataupdated') {
      this.updateGain();
    }
  },

  async start({ getConfig }) {
    this.config = await getConfig();

    document.addEventListener(
      'peard:audio-can-play',
      this.audioCanPlayHandler,
      {
        passive: true,
      },
    );
    document.addEventListener('videodatachange', this.videoDataChangeHandler, {
      passive: true,
    });

    const graph = getAudioGraph();
    if (graph) this.attach(graph);
  },

  onPlayerApiReady(playerApi) {
    this.api = playerApi;

    const graph = getAudioGraph();
    if (graph) this.attach(graph);
    this.updateGain();
  },

  stop() {
    document.removeEventListener(
      'peard:audio-can-play',
      this.audioCanPlayHandler,
    );
    document.removeEventListener(
      'videodatachange',
      this.videoDataChangeHandler,
    );
    this.detach();
  },

  onConfigChange(newConfig) {
    this.config = newConfig;
    this.connectOutput();
    this.updateGain();
  },
});
