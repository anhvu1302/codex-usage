import {
  cloneElement,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactElement,
} from "react";

import { cn } from "@/web/lib/utils";

export type ChartConfig = Record<string, { color?: string; label?: string }>;

type ChartDimensions = {
  height: number;
  width: number;
};

function ChartContainer({
  children,
  className,
  config,
  ...props
}: ComponentProps<"div"> & { config: ChartConfig }) {
  const container = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState<ChartDimensions | null>(null);
  const variables = Object.fromEntries(
    Object.entries(config).flatMap(([key, value]) =>
      value.color ? [[`--color-${key}`, value.color]] : [],
    ),
  );

  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;

    let animationFrame: number | undefined;
    const updateDimensions = (width: number, height: number) => {
      const nextWidth = Math.round(width);
      const nextHeight = Math.round(height);
      const next =
        nextWidth > 0 && nextHeight > 0 ? { height: nextHeight, width: nextWidth } : null;
      setDimensions((current) =>
        current?.height === next?.height && current?.width === next?.width ? current : next,
      );
    };
    const measure = () => {
      const bounds = element.getBoundingClientRect();
      updateDimensions(bounds.width, bounds.height);
    };

    measure();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(([entry]) => {
        if (entry) updateDimensions(entry.contentRect.width, entry.contentRect.height);
      });
      observer.observe(element);
      return () => observer.disconnect();
    }

    const handleResize = () => {
      if (animationFrame !== undefined) window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(measure);
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      if (animationFrame !== undefined) window.cancelAnimationFrame(animationFrame);
    };
  }, []);

  return (
    <div
      data-slot="chart"
      className={cn(
        "[&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground h-72 w-full text-xs",
        className,
      )}
      style={variables}
      {...props}
      ref={container}
    >
      {dimensions ? (
        <div className="h-0 w-0 overflow-visible">
          {cloneElement(children as ReactElement<Partial<ChartDimensions>>, dimensions)}
        </div>
      ) : null}
    </div>
  );
}

export { ChartContainer };
