import { cn } from '~/utils';

/** 装饰性勾选指示（整行可点击的场景）：非交互控件，勾选状态由外层行表达。
 * 尺寸用 className 覆盖（缺省 size-4，小行高场景传 size-3.5）。 */
export default function CheckIndicator({
  on,
  className = 'size-4',
}: {
  on: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded border',
        className,
        on ? 'border-indigo-500 bg-indigo-500' : 'border-border-medium',
      )}
      aria-hidden="true"
    >
      {on && <span className="size-2 rounded-sm bg-white" />}
    </span>
  );
}
