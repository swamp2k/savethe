// JSX typing for the <model-viewer> custom element (@google/model-viewer).
// Only the attributes we actually use; all are plain string/boolean HTML
// attributes, which is how React 19 passes props to custom elements.
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'model-viewer': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string;
        alt?: string;
        autoplay?: boolean;
        'animation-name'?: string;
        'animation-crossfade-duration'?: string;
        'camera-orbit'?: string;
        'shadow-intensity'?: string;
        'interaction-prompt'?: string;
        'disable-zoom'?: boolean;
        'disable-tap'?: boolean;
        'camera-controls'?: boolean;
        'auto-rotate'?: boolean;
        loading?: 'auto' | 'lazy' | 'eager';
      };
    }
  }
}

export {};
