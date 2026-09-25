import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import type { NavLink } from '~/common';
import { useActivePanel, resolveActivePanel, DEFAULT_PANEL } from '~/Providers';

export default function Nav({ links }: { links: NavLink[] }) {
  const { active, setActive } = useActivePanel();
  const location = useLocation();
  const effectiveActive = resolveActivePanel(active, links);

  /* TerraVox: /toolbox owns the tool-list panel the way chat routes pair with
   * the conversations panel. The coupling fires on route TRANSITIONS only —
   * direct visits and reloads line the panel up (prevPath starts empty, so the
   * first run counts as entering), but while staying on /toolbox the user is
   * free to switch panels; leaving the route only resets the toolbox panel,
   * never a user's own pick. */
  const prevPath = useRef('');
  useEffect(() => {
    const wasToolbox = prevPath.current.startsWith('/toolbox');
    const isToolbox = location.pathname.startsWith('/toolbox');
    prevPath.current = location.pathname;
    if (isToolbox && !wasToolbox) {
      if (active !== 'toolbox') {
        setActive('toolbox');
      }
    } else if (!isToolbox && wasToolbox && active === 'toolbox') {
      setActive(DEFAULT_PANEL);
    }
  }, [location.pathname, active, setActive]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto overflow-x-hidden text-text-primary">
      {links.map((link) =>
        link.id === effectiveActive && link.Component ? <link.Component key={link.id} /> : null,
      )}
    </div>
  );
}
