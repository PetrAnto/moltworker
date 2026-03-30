import { CommandBar } from './CommandBar';

export interface BottomBarProps {
  activePersonality?: string;
}

/**
 * BottomBar — cockpit bottom command row.
 * Three-column grid: left (mode indicators) | center (AI selector) | right (actions).
 * The center column holds CommandBar with predictable max-width (580px via CSS grid).
 */
export function BottomBar({ activePersonality }: BottomBarProps) {
  return (
    <div className="cockpit-bottom-bar">
      {/* Left column — mode indicators (extensible) */}
      <div className="cockpit-bottom-bar__left">
        {/* Future: mode/module indicator chips */}
      </div>

      {/* Center column — AI selector (CommandBar) */}
      <div className="cockpit-bottom-bar__center">
        <CommandBar activePersonality={activePersonality} />
      </div>

      {/* Right column — actions (extensible) */}
      <div className="cockpit-bottom-bar__right">
        {/* Future: send button, settings gear */}
      </div>
    </div>
  );
}

export default BottomBar;
