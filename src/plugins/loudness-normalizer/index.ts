import { t } from '@/i18n';
import { createPlugin } from '@/utils';

import { renderer } from './renderer';

import type { MenuTemplate } from '@/menu';
import type { MenuContext } from '@/types/contexts';

export type LoudnessNormalizerPluginConfig = {
  enabled: boolean;
  /**
   * Loudness every track is brought to (LKFS)
   * @default -14
   */
  targetLkfs: number;
  /**
   * Maximum gain applied to quiet tracks (dB), 0 = only attenuate
   * @default 6
   */
  maxBoostDb: number;
  /**
   * Limit peaks so boosted tracks do not clip
   * @default true
   */
  limiter: boolean;
};

const targetOptions = [-11, -14, -16, -18];
const maxBoostOptions = [0, 6, 10];

export default createPlugin({
  name: () => t('plugins.loudness-normalizer.name'),
  description: () => t('plugins.loudness-normalizer.description'),
  restartNeeded: false,
  config: {
    enabled: false,
    targetLkfs: -14,
    maxBoostDb: 6,
    limiter: true,
  } as LoudnessNormalizerPluginConfig,
  menu: async ({
    getConfig,
    setConfig,
  }: MenuContext<LoudnessNormalizerPluginConfig>): Promise<MenuTemplate> => {
    const config = await getConfig();

    return [
      {
        label: t('plugins.loudness-normalizer.menu.target'),
        type: 'submenu',
        submenu: targetOptions.map((targetLkfs) => ({
          label: `${targetLkfs} LKFS`,
          type: 'radio',
          checked: config.targetLkfs === targetLkfs,
          click() {
            setConfig({ targetLkfs });
          },
        })),
      },
      {
        label: t('plugins.loudness-normalizer.menu.max-boost.label'),
        type: 'submenu',
        submenu: maxBoostOptions.map((maxBoostDb) => ({
          label:
            maxBoostDb === 0
              ? t('plugins.loudness-normalizer.menu.max-boost.none')
              : `+${maxBoostDb} dB`,
          type: 'radio',
          checked: config.maxBoostDb === maxBoostDb,
          click() {
            setConfig({ maxBoostDb });
          },
        })),
      },
      {
        label: t('plugins.loudness-normalizer.menu.limiter'),
        type: 'checkbox',
        checked: config.limiter,
        click(item) {
          setConfig({ limiter: item.checked });
        },
      },
    ];
  },
  renderer,
});
