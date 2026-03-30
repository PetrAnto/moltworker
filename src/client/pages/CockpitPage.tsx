import { BottomBar } from '../components/cockpit/BottomBar';
import '../components/cockpit/cockpit.css';

/**
 * CockpitShell — the main cockpit page at /_admin/cockpit.
 * Houses the AI selector (BottomBar → CommandBar) in a dark minimal environment.
 */
export default function CockpitPage() {
  // Future: activePersonality would come from gecko state / user preferences
  const activePersonality = 'Tach Cygnus';

  return (
    <div className="cockpit-shell">
      {/* Main content area (hero input, chat, etc.) */}
      <div className="cockpit-main">
        {/* Placeholder — will hold chat/hero input in future sprints */}
      </div>

      {/* Bottom command row with AI selector */}
      <BottomBar activePersonality={activePersonality} />
    </div>
  );
}
