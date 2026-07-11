"use client";

import type { HTMLAttributes, ReactNode } from "react";

export function Panel({
  children,
  className = "",
  ...rest
}: HTMLAttributes<HTMLDivElement> & {
  children: ReactNode;
}): React.ReactElement {
  return (
    <div className={`sf-panel ${className}`.trim()} {...rest}>
      {children}
    </div>
  );
}
