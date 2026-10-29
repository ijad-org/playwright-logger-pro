import React, {type ComponentProps, type ReactNode} from 'react';
import MDXComponents from '@theme-original/MDXComponents';
import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';
import TerminalOutput from '@site/src/components/TerminalOutput';

/** Tables scroll inside their own focusable region instead of widening the page. */
function Table(props: ComponentProps<'table'>): ReactNode {
  return (
    <div className="plp-table-scroll" role="region" aria-label="Scrollable table" tabIndex={0}>
      <table {...props} />
    </div>
  );
}

export default {
  ...MDXComponents,
  table: Table,
  Tabs,
  TabItem,
  TerminalOutput,
};
