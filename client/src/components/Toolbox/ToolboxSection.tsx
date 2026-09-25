import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown } from 'lucide-react';
import { useMediaQuery, buttonVariants, Spinner } from '@librechat/client';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type { TranslationKeys } from '~/hooks/useLocalize';
import type { ToolManifest } from './types';
import useSidebarToggle from '~/hooks/Nav/useSidebarToggle';
import { useLocalize, useLocalStorage } from '~/hooks';
import { Collapse } from '~/components/ui';
import { useToolsQuery } from './api';
import { cn } from '~/utils';

/** Namespace → i18n key for the sidebar groups; unknown namespaces show the raw name. */
const GROUP_LABEL_KEYS: Record<string, TranslationKeys> = {
  nextcloud: 'com_toolbox_group_nextcloud',
  spatial: 'com_toolbox_group_spatial',
  echo: 'com_toolbox_group_echo',
  demo: 'com_toolbox_group_demo',
};

const groupOf = (tool: ToolManifest): string => tool.tool_id.split('.')[0] ?? tool.tool_id;

/**
 * Sidebar panel for /toolbox — the tool list the conversations list is on the
 * chat route: grouped, collapsible sections with a search field; picking a tool
 * navigates to `/toolbox?tool=<id>` and the main surface renders its runner.
 */
export default function ToolboxSection() {
  const localize = useLocalize();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const isSmallScreen = useMediaQuery('(max-width: 768px)');
  const { setSidebarOpen } = useSidebarToggle();
  const { data: catalog, isLoading, error } = useToolsQuery();
  const [search, setSearch] = useState('');
  const [groupsExpanded, setGroupsExpanded] = useLocalStorage<Record<string, boolean>>(
    'toolbox:groups-expanded',
    {},
  );

  const activeTool = searchParams.get('tool');

  /** Entering the panel from the icon strip navigates to the tool surface.
   * Mount-only (initial path captured once): re-running on every pathname
   * change would hijack navigation away from /toolbox mid-unmount and bounce
   * the user back. */
  const initialPath = useRef(location.pathname);
  useEffect(() => {
    if (!initialPath.current.startsWith('/toolbox')) {
      navigate('/toolbox', { replace: true });
    }
  }, [navigate]);

  /** Selecting a tool is the common close path on mobile — mirror ConversationsSection. */
  const toggleNav = useCallback(
    (afterSlide?: () => void) => {
      if (isSmallScreen) {
        setSidebarOpen(false, afterSlide);
        return;
      }
      afterSlide?.();
    },
    [isSmallScreen, setSidebarOpen],
  );

  const groups = useMemo(() => {
    const tools = catalog?.tools ?? [];
    const q = search.trim().toLowerCase();
    const matched = q
      ? tools.filter((t) =>
          [t.tool_id, t.display_name, t.description].some((s) => s?.toLowerCase().includes(q)),
        )
      : tools;
    const meta = new Map((catalog?.groups ?? []).map((g) => [g.name, g]));
    const byGroup = new Map<string, ToolManifest[]>();
    for (const tool of matched) {
      const ns = groupOf(tool);
      const list = byGroup.get(ns) ?? [];
      list.push(tool);
      byGroup.set(ns, list);
    }
    const orderOf = (ns: string) => meta.get(ns)?.sort_order ?? 1000;
    return [...byGroup.entries()].sort(([a], [b]) => orderOf(a) - orderOf(b) || a.localeCompare(b));
  }, [catalog, search]);

  /** Group label: gateway display_name (admin-managed) > built-in i18n > raw namespace. */
  const groupLabel = useCallback(
    (ns: string) => {
      const display = catalog?.groups?.find((g) => g.name === ns)?.display_name;
      if (display) {
        return display;
      }
      const labelKey = GROUP_LABEL_KEYS[ns];
      return labelKey ? localize(labelKey) : ns;
    },
    [catalog, localize],
  );

  const selectTool = (toolId: string) => {
    toggleNav(() => navigate(`/toolbox?tool=${encodeURIComponent(toolId)}`));
  };

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden pb-3 pt-2"
      role="region"
      aria-label={localize('com_toolbox_title')}
    >
      <div className="flex items-center px-3 pb-1">
        <input
          type="search"
          className="w-full rounded-lg border border-border-light bg-surface-primary px-3 py-1.5 text-sm text-text-primary placeholder-text-tertiary focus:border-border-medium focus:outline-none"
          placeholder={localize('com_toolbox_search')}
          aria-label={localize('com_toolbox_search')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="scrollbar-gutter-stable min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <div className="flex min-h-full flex-col">
          {isLoading && (
            <div className="flex justify-center py-8">
              <Spinner />
            </div>
          )}
          {!!error && (
            <div
              role="alert"
              className="border-text-error/40 bg-text-error/10 text-text-error mx-3 mt-1 rounded-lg border px-3 py-2 text-xs"
            >
              <p className="font-semibold">{localize('com_toolbox_load_error')}</p>
              <p>
                {(error as { status?: number }).status === 503
                  ? localize('com_toolbox_relogin')
                  : localize('com_toolbox_retry_later')}
              </p>
            </div>
          )}
          {!isLoading && !error && groups.length === 0 && (
            <p className="py-8 text-center text-sm text-text-tertiary">
              {localize('com_toolbox_empty')}
            </p>
          )}
          {groups.map(([ns, items]) => {
            const expanded = groupsExpanded[ns] !== false;
            const toggle = () => setGroupsExpanded({ ...groupsExpanded, [ns]: !expanded });
            return (
              <div key={ns} className="flex flex-col px-3 text-sm" role="group">
                <div className="flex h-8 w-full items-center pr-2">
                  <button
                    onClick={toggle}
                    className={cn(
                      buttonVariants({ variant: 'section-header' }),
                      /* 分组标题与工具名同号（text-sm），靠次级色与工具名拉开层次 */
                      'group min-w-0 flex-1 text-sm font-semibold text-text-secondary',
                    )}
                    type="button"
                    aria-expanded={expanded}
                  >
                    <span className="select-none truncate">{groupLabel(ns)}</span>
                    <ChevronDown
                      className={cn(
                        'h-3.5 w-3.5 shrink-0 transition-transform duration-200',
                        expanded ? '' : '-rotate-90',
                      )}
                      aria-hidden="true"
                    />
                  </button>
                </div>
                <Collapse open={expanded}>
                  <div className="pt-0.5">
                    {items.map((tool) => {
                      const isActive = tool.tool_id === activeTool;
                      return (
                        <button
                          key={tool.tool_id}
                          onClick={() => selectTool(tool.tool_id)}
                          aria-current={isActive}
                          className={cn(
                            'relative flex h-9 w-full items-center rounded-lg px-2 py-1.5 text-start transition-colors',
                            isActive
                              ? 'bg-surface-active-alt before:absolute before:bottom-1 before:left-0 before:top-1 before:w-0.5 before:rounded-full before:bg-text-primary'
                              : 'hover:bg-surface-active-alt',
                          )}
                        >
                          <span className="min-w-0 flex-1 truncate">{tool.display_name}</span>
                          {tool.dangerous && (
                            <AlertTriangle
                              className="ml-2 h-3.5 w-3.5 shrink-0 text-amber-500"
                              aria-hidden="true"
                            />
                          )}
                        </button>
                      );
                    })}
                  </div>
                </Collapse>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
