import { commandScore } from '@affine/cmdk';
import { useCollectionManager } from '@affine/component/page-list';
import type { Collection } from '@affine/env/filter';
import { Trans } from '@affine/i18n';
import { useAFFiNEI18N } from '@affine/i18n/hooks';
import { EdgelessIcon, PageIcon, ViewLayersIcon } from '@blocksuite/icons';
import type { Page, PageMeta } from '@blocksuite/store';
import {
  useBlockSuitePageMeta,
  usePageMetaHelper,
} from '@toeverything/hooks/use-block-suite-page-meta';
import {
  getWorkspace,
  waitForWorkspace,
} from '@toeverything/infra/__internal__/workspace';
import {
  currentPageIdAtom,
  currentWorkspaceIdAtom,
  getCurrentStore,
} from '@toeverything/infra/atom';
import {
  type AffineCommand,
  AffineCommandRegistry,
  type CommandCategory,
  PreconditionStrategy,
} from '@toeverything/infra/command';
import { atom, useAtomValue } from 'jotai';
import groupBy from 'lodash/groupBy';
import { useMemo } from 'react';

import {
  openQuickSearchModalAtom,
  pageSettingsAtom,
  recentPageIdsBaseAtom,
} from '../../../atoms';
import { useCurrentWorkspace } from '../../../hooks/current/use-current-workspace';
import { useNavigateHelper } from '../../../hooks/use-navigate-helper';
import { WorkspaceSubPath } from '../../../shared';
import { currentCollectionsAtom } from '../../../utils/user-setting';
import { usePageHelper } from '../../blocksuite/block-suite-page-list/utils';
import type { CMDKCommand, CommandContext } from './types';

export const cmdkQueryAtom = atom('');
export const cmdkValueAtom = atom('');

// like currentWorkspaceAtom, but not throw error
const safeCurrentPageAtom = atom<Promise<Page | undefined>>(async get => {
  const currentWorkspaceId = get(currentWorkspaceIdAtom);
  if (!currentWorkspaceId) {
    return;
  }

  const currentPageId = get(currentPageIdAtom);

  if (!currentPageId) {
    return;
  }

  const workspace = getWorkspace(currentWorkspaceId);
  await waitForWorkspace(workspace);
  const page = workspace.getPage(currentPageId);

  if (!page) {
    return;
  }

  if (!page.loaded) {
    await page.waitForLoaded();
  }
  return page;
});

export const commandContextAtom = atom<Promise<CommandContext>>(async get => {
  const currentPage = await get(safeCurrentPageAtom);
  const pageSettings = get(pageSettingsAtom);

  return {
    currentPage,
    pageMode: currentPage ? pageSettings[currentPage.id]?.mode : undefined,
  };
});

function filterCommandByContext(
  command: AffineCommand,
  context: CommandContext
) {
  if (command.preconditionStrategy === PreconditionStrategy.Always) {
    return true;
  }
  if (command.preconditionStrategy === PreconditionStrategy.InEdgeless) {
    return context.pageMode === 'edgeless';
  }
  if (command.preconditionStrategy === PreconditionStrategy.InPaper) {
    return context.pageMode === 'page';
  }
  if (command.preconditionStrategy === PreconditionStrategy.InPaperOrEdgeless) {
    return !!context.currentPage;
  }
  if (command.preconditionStrategy === PreconditionStrategy.Never) {
    return false;
  }
  if (typeof command.preconditionStrategy === 'function') {
    return command.preconditionStrategy();
  }
  return true;
}

let quickSearchOpenCounter = 0;
const openCountAtom = atom(get => {
  if (get(openQuickSearchModalAtom)) {
    quickSearchOpenCounter++;
  }
  return quickSearchOpenCounter;
});

export const filteredAffineCommands = atom(async get => {
  const context = await get(commandContextAtom);
  // reset when modal open
  get(openCountAtom);
  const commands = AffineCommandRegistry.getAll();
  return commands.filter(command => {
    return filterCommandByContext(command, context);
  });
});

const useWorkspacePages = () => {
  const [currentWorkspace] = useCurrentWorkspace();
  const pages = useBlockSuitePageMeta(currentWorkspace.blockSuiteWorkspace);
  return pages;
};

const useRecentPages = () => {
  const pages = useWorkspacePages();
  const recentPageIds = useAtomValue(recentPageIdsBaseAtom);
  return useMemo(() => {
    return recentPageIds
      .map(pageId => {
        const page = pages.find(page => page.id === pageId);
        return page;
      })
      .filter((p): p is PageMeta => !!p);
  }, [recentPageIds, pages]);
};

const valueWrapperStart = '__>>>';
const valueWrapperEnd = '<<<__';

export const pageToCommand = (
  category: CommandCategory,
  page: PageMeta,
  store: ReturnType<typeof getCurrentStore>,
  navigationHelper: ReturnType<typeof useNavigateHelper>,
  t: ReturnType<typeof useAFFiNEI18N>
): CMDKCommand => {
  const pageMode = store.get(pageSettingsAtom)?.[page.id]?.mode;
  const currentWorkspaceId = store.get(currentWorkspaceIdAtom);
  const label = page.title || t['Untitled']();
  return {
    id: page.id,
    label: label,
    // hack: when comparing, the part between >>> and <<< will be ignored
    // adding this patch so that CMDK will not complain about duplicated commands
    value:
      label + valueWrapperStart + page.id + '.' + category + valueWrapperEnd,
    originalValue: label,
    category: category,
    run: () => {
      if (!currentWorkspaceId) {
        console.error('current workspace not found');
        return;
      }
      navigationHelper.jumpToPage(currentWorkspaceId, page.id);
    },
    icon: pageMode === 'edgeless' ? <EdgelessIcon /> : <PageIcon />,
    timestamp: page.updatedDate,
  };
};

const contentMatchedMagicString = '__$$content_matched$$__';

export const usePageCommands = () => {
  // todo: considering collections for searching pages
  // const { savedCollections } = useCollectionManager(currentCollectionsAtom);
  const recentPages = useRecentPages();
  const pages = useWorkspacePages();
  const store = getCurrentStore();
  const [workspace] = useCurrentWorkspace();
  const pageHelper = usePageHelper(workspace.blockSuiteWorkspace);
  const pageMetaHelper = usePageMetaHelper(workspace.blockSuiteWorkspace);
  const query = useAtomValue(cmdkQueryAtom);
  const navigationHelper = useNavigateHelper();
  const t = useAFFiNEI18N();

  return useMemo(() => {
    let results: CMDKCommand[] = [];
    if (query.trim() === '') {
      results = recentPages.map(page => {
        return pageToCommand('affine:recent', page, store, navigationHelper, t);
      });
    } else {
      // queried pages that has matched contents
      const searchResults = Array.from(
        workspace.blockSuiteWorkspace.search({ query }).values()
      ) as unknown as { space: string; content: string }[];

      const pageIds = searchResults.map(id => {
        if (id.space.startsWith('space:')) {
          return id.space.slice(6);
        } else {
          return id.space;
        }
      });

      results = pages.map(page => {
        const pageMode = store.get(pageSettingsAtom)?.[page.id]?.mode;
        const category =
          pageMode === 'edgeless' ? 'affine:edgeless' : 'affine:pages';
        const command = pageToCommand(
          category,
          page,
          store,
          navigationHelper,
          t
        );

        if (pageIds.includes(page.id)) {
          // hack to make the page always showing in the search result
          command.value += contentMatchedMagicString;
        }

        return command;
      });

      // check if the pages have exact match. if not, we should show the "create page" command
      if (results.every(command => command.originalValue !== query)) {
        results.push({
          id: 'affine:pages:create-page',
          label: (
            <Trans
              i18nKey="com.affine.cmdk.affine.create-new-page-as"
              values={{ query }}
            >
              Create New Page as: <strong>query</strong>
            </Trans>
          ),
          value: 'affine::create-page' + query, // hack to make the page always showing in the search result
          category: 'affine:creation',
          run: async () => {
            const page = pageHelper.createPage();
            await page.waitForLoaded();
            pageMetaHelper.setPageTitle(page.id, query);
          },
          icon: <PageIcon />,
        });

        results.push({
          id: 'affine:pages:create-edgeless',
          label: (
            <Trans
              values={{ query }}
              i18nKey="com.affine.cmdk.affine.create-new-edgeless-as"
            >
              Create New Edgeless as: <strong>query</strong>
            </Trans>
          ),
          value: 'affine::create-edgeless' + query, // hack to make the page always showing in the search result
          category: 'affine:creation',
          run: async () => {
            const page = pageHelper.createEdgeless();
            await page.waitForLoaded();
            pageMetaHelper.setPageTitle(page.id, query);
          },
          icon: <EdgelessIcon />,
        });
      }
    }
    return results;
  }, [
    pageHelper,
    pageMetaHelper,
    navigationHelper,
    pages,
    query,
    recentPages,
    store,
    t,
    workspace.blockSuiteWorkspace,
  ]);
};

export const collectionToCommand = (
  collection: Collection,
  store: ReturnType<typeof getCurrentStore>,
  navigationHelper: ReturnType<typeof useNavigateHelper>,
  selectCollection: ReturnType<typeof useCollectionManager>['selectCollection'],
  t: ReturnType<typeof useAFFiNEI18N>
): CMDKCommand => {
  const currentWorkspaceId = store.get(currentWorkspaceIdAtom);
  const label = collection.name || t['Untitled']();
  const category = 'affine:collections';
  return {
    id: collection.id,
    label: label,
    // hack: when comparing, the part between >>> and <<< will be ignored
    // adding this patch so that CMDK will not complain about duplicated commands
    value:
      label +
      valueWrapperStart +
      collection.id +
      '.' +
      category +
      valueWrapperEnd,
    originalValue: label,
    category: category,
    run: () => {
      if (!currentWorkspaceId) {
        console.error('current workspace not found');
        return;
      }
      navigationHelper.jumpToSubPath(currentWorkspaceId, WorkspaceSubPath.ALL);
      selectCollection(collection.id);
    },
    icon: <ViewLayersIcon />,
  };
};

export const useCollectionsCommands = () => {
  // todo: considering collections for searching pages
  const { savedCollections, selectCollection } = useCollectionManager(
    currentCollectionsAtom
  );
  const store = getCurrentStore();
  const query = useAtomValue(cmdkQueryAtom);
  const navigationHelper = useNavigateHelper();
  const t = useAFFiNEI18N();

  return useMemo(() => {
    let results: CMDKCommand[] = [];
    if (query.trim() === '') {
      return results;
    } else {
      results = savedCollections.map(collection => {
        const command = collectionToCommand(
          collection,
          store,
          navigationHelper,
          selectCollection,
          t
        );
        return command;
      });
      return results;
    }
  }, [query, savedCollections, store, navigationHelper, selectCollection, t]);
};

export const useCMDKCommandGroups = () => {
  const pageCommands = usePageCommands();
  const collectionCommands = useCollectionsCommands();
  const affineCommands = useAtomValue(filteredAffineCommands);

  return useMemo(() => {
    const commands = [
      ...pageCommands,
      ...collectionCommands,
      ...affineCommands,
    ];
    const groups = groupBy(commands, command => command.category);
    return Object.entries(groups) as [CommandCategory, CMDKCommand[]][];
  }, [affineCommands, collectionCommands, pageCommands]);
};

export const customCommandFilter = (value: string, search: string) => {
  // strip off the part between __>>> and <<<__
  let label = value.replace(
    new RegExp(valueWrapperStart + '.*' + valueWrapperEnd, 'g'),
    ''
  );

  const pageContentMatched = label.includes(contentMatchedMagicString);
  if (pageContentMatched) {
    label = label.replace(contentMatchedMagicString, '');
  }

  const originalScore = commandScore(label, search);

  // if the command has matched the content but not the label,
  // we should give it a higher score, but not too high
  if (originalScore < 0.01 && pageContentMatched) {
    return 0.3;
  }
  return originalScore;
};

export const useCommandFilteredStatus = (
  groups: [CommandCategory, CMDKCommand[]][]
) => {
  // for each of the groups, show the count of commands that has matched the query
  const query = useAtomValue(cmdkQueryAtom);
  return useMemo(() => {
    return Object.fromEntries(
      groups.map(([category, commands]) => {
        return [category, getCommandFilteredCount(commands, query)] as const;
      })
    ) as Record<CommandCategory, number>;
  }, [groups, query]);
};

function getCommandFilteredCount(commands: CMDKCommand[], query: string) {
  return commands.filter(command => {
    return command.value && customCommandFilter(command.value, query) > 0;
  }).length;
}
