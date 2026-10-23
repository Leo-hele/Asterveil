import type { FeatureModule } from '../../core/module';
import { mountChatPage } from '../../site/chat-page';

export default {
  mount({ scope }) {
    mountChatPage(scope);
  },
} satisfies FeatureModule;
