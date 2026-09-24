import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import type { NavLink } from '~/common';
import { useActivePanel, resolveActivePanel, DEFAULT_PANEL } from '~/Providers';

export default function Nav({ links }: { links: NavLink[] }) {
  const { active, setActive } = useActivePanel();
  const location = useLocation();
  const effectiveActive = resolveActivePanel(active, links);

  /* TerraVox: /toolbox owns the tool-list panel the way chat routes pair with
   * the conversations panel. The route (not a click inside the sidebar) has to
   * drive this so direct visits and reloads line the panel up too; leaving the
   * route only resets a panel this coupling had set, never a user's own pick. */
  useEffect(() => {
    if (location.pathname.startsWith('/toolbox')) {
      if (active !== 'toolbox') {
        setActive('toolbox');
      }
    } else if (active === 'toolbox') {
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
