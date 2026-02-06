import { registerConditionalHelpers } from './conditional';
import { registerFileHelpers } from './file';
import { registerFormattingHelpers } from './formatting';

export const registerAllHelpers = (): void => {
  registerConditionalHelpers();
  registerFileHelpers();
  registerFormattingHelpers();
};
