// Public entry for `@vibecook/mille-ui/icons`.
//
// Re-exports the icon subsystem: schema validator, resolver, SVG
// sanitizer, async theme loader, the default theme, and the
// <FileIcon> component.

export {
  createIconResolver,
  defaultIconTheme,
  duotoneIconTheme,
  minimalIconTheme,
  FileIcon,
  IconThemeValidationError,
  loadIconTheme,
  sanitizeSvg,
  SvgSanitizationError,
  validateIconTheme,
} from './icons/index.js';

export type {
  FileIconProps,
  IconDefinition,
  IconResolver,
  IconResolverOptions,
  IconTheme,
  IconThemeTokens,
  LoadIconThemeOptions,
  ResolvedIcon,
} from './icons/index.js';
