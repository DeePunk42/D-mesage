import { startService } from './service.js';
import { bindWhenFree } from './startup.js';

export default {
  id: 'd-message',
  async server(_input, options = {}) {
    if (!options.uiKey) return {};
    // One-shot Magpie CLI hosts receive an ephemeral port in the page service's
    // designated option. Only the normal page host should restore the saved MCP.
    const port = Number(options.port || 34891);
    bindWhenFree(
      () => startService(options, { restoreMcp: port === Number(options.pageHostPort || 34891) }),
      {
        waiting: () => console.warn('D-message: waiting for page port ' + port + ' to be released'),
        failed: (error) =>
          console.error('D-message: page service startup failed', error.code || error.name),
      },
    );
    return {};
  },
};
