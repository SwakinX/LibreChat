import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAtom } from 'jotai';
import { AlertTriangle, ChevronDown } from 'lucide-react';
import { useMediaQuery, buttonVariants, Spinner } from '@librechat/client';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type { TranslationKeys } from '~/hooks/useLocalize';
import type { MergedTool } from './toolStatus';
import useSidebarToggle from '~/hooks/Nav/useSidebarToggle';
import { useMergedTools } from './toolhostHooks';
import { groupsExpandedAtom } from './atoms';
import { isDesktopTool } from './toolStatus';
import { Collapse } from '~/components/ui';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

/** Namespace → i18n key for the sidebar groups; unknown namespaces show the raw name. */
const GROUP_LABEL_KEYS: Record<string, TranslationKeys> = {
  nextcloud: 'com_toolbox_group_nextcloud',
  spatial: 'com_toolbox_group_spatial',
  echo: 'com_toolbox_group_echo',
  demo: 'com_toolbox_group_demo',
};

const groupOf = (tool: MergedTool): string =>
  tool.manifest.tool_id.split('.')[0] ?? tool.manifest.tool_id;

/**
 * Sidebar panel for /toolbox — the tool list the conversations list is on the
 * chat route: grouped, collapsible sections with a search field; picking a tool
 * navigates to `/toolbox?tool=<id>` and the main surface renders its runner.
 * Desktop tools carry a local-state badge (not installed / installed vX /
 * update available) merged from the Toolhost.
 */
export default function ToolboxSection() {
  const localize = useLocalize();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const isSmallScreen = useMediaQuery('(max-width: 768px)');
  const { setSidebarOpen } = useSidebarToggle();
  const { tools, groups: groupMeta, isLoading, error } = useMergedTools();
  const [search, setSearch] = useState('');
  /* Same key + JSON shape as the previous useLocalStorage hook — saved
   * collapse state carries over; Jotai lets the header/panel share it. */
  const [groupsExpanded, setGroupsExpanded] = useAtom(groupsExpandedAtom);

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
    const q = search.trim().toLowerCase();
    const matched = q
      ? tools.filter((tool) =>
          [tool.manifest.tool_id, tool.manifest.display_name, tool.manifest.description].some((s) =>
            s?.toLowerCase().includes(q),
          ),
        )
      : tools;
    const meta = new Map((groupMeta ?? []).map((group) => [group.name, group]));
    const byGroup = new Map<string, MergedTool[]>();
    for (const tool of matched) {
      const ns = groupOf(tool);
      const list = byGroup.get(ns) ?? [];
      list.push(tool);
      byGroup.set(ns, list);
    }
    const orderOf = (ns: string) => meta.get(ns)?.sort_order ?? 1000;
    return [...byGroup.entries()].sort(([a], [b]) => orderOf(a) - orderOf(b) || a.localeCompare(b));
  }, [tools, groupMeta, search]);

  /** Group label: gateway display_name (admin-managed) > built-in i18n > raw namespace. */
  const groupLabel = useCallback(
    (ns: string) => {
      const display = groupMeta?.find((group) => group.name === ns)?.display_name;
      if (display) {
        return display;
      }
      const labelKey = GROUP_LABEL_KEYS[ns];
      return labelKey ? localize(labelKey) : ns;
    },
    [groupMeta, localize],
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
                      const isActive = tool.manifest.tool_id === activeTool;
                      return (
                        <button
                          key={tool.manifest.tool_id}
                          onClick={() => selectTool(tool.manifest.tool_id)}
                          aria-current={isActive}
                          className={cn(
                            'relative flex h-9 w-full items-center rounded-lg px-2 py-1.5 text-start transition-colors',
                            isActive
                              ? 'bg-surface-active-alt before:absolute before:bottom-1 before:left-0 before:top-1 before:w-0.5 before:rounded-full before:bg-text-primary'
                              : 'hover:bg-surface-active-alt',
                          )}
                        >
                          <span className="min-w-0 flex-1 truncate">
                            {tool.manifest.display_name}
                          </span>
                          {tool.manifest.dangerous && (
                            <AlertTriangle
                              className="ml-2 h-3.5 w-3.5 shrink-0 text-amber-500"
                              aria-hidden="true"
                            />
                          )}
                          {isDesktopTool(tool.manifest) && <LocalBadge tool={tool} />}
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

/** Desktop-tool local-state chip: red damaged / gray not-installed / emerald
 * vX / amber vX→vY. Damaged wins over version state — it blocks running. */
function LocalBadge({ tool }: { tool: MergedTool }) {
  const localize = useLocalize();
  if (tool.status === 'not_installed') {
    return (
      <span
        className="ml-2 shrink-0 rounded-full border border-border-medium px-1.5 py-0.5 text-[10px] text-text-tertiary"
        title={localize('com_toolbox_badge_not_installed')}
      >
        {localize('com_toolbox_badge_not_installed')}
      </span>
    );
  }
  if (tool.damaged) {
    return (
      <span
        className="border-text-error/40 bg-text-error/10 text-text-error ml-2 shrink-0 rounded-full border px-1.5 py-0.5 text-[10px]"
        title={localize('com_toolbox_repair_hint')}
      >
        {localize('com_toolbox_damaged')}
      </span>
    );
  }
  if (tool.status === 'update_available' && tool.latestVersion) {
    return (
      <span
        className="ml-2 shrink-0 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-600 dark:text-amber-400"
        title={localize('com_toolbox_badge_update_available')}
      >
        {`${tool.local?.installed_version} → v${tool.latestVersion}`}
      </span>
    );
  }
  const version = tool.local?.installed_version;
  const label = version
    ? localize('com_toolbox_badge_installed', { version })
    : localize('com_toolbox_badge_installed_plain');
  return (
    <span
      className="ml-2 shrink-0 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-600 dark:text-emerald-400"
      title={label}
    >
      {label}
    </span>
  );
}
