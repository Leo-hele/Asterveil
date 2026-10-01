import type { FeatureModule } from '../../core/module';
import { replaceUserNames } from '../../site/real-names';

export default {
  mount({ scope }) {
    replaceUserNames(scope);
  },
} satisfies FeatureModule;
