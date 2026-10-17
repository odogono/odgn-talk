import type { Immutable } from 'immer';
import '@preact/signals';
import { Component, createRef, render } from 'preact';
import type { StackEditor } from './editing';
import type { Asset, Page } from './model';

const THUMBNAIL_WIDTH = 96;

/** The shell shares its direct DOM Page renderer with the miniature. */
type PageRenderer = (
  page: Immutable<Page>,
  designWidth: number,
  assets: Immutable<Asset[]>,
  into: HTMLElement,
) => void;

type ThumbnailProps = {
  assets: Immutable<Asset[]>;
  designWidth: number;
  drawPage: PageRenderer;
  page: Immutable<Page>;
};

// Use Preact's native memoisation hook: importing preact/compat's memo also
// changes input events globally, including the Info panel's name commits.
class Thumbnail extends Component<ThumbnailProps> {
  miniature = createRef<HTMLDivElement>();

  shouldComponentUpdate(next: ThumbnailProps): boolean {
    return (
      next.page !== this.props.page ||
      next.designWidth !== this.props.designWidth ||
      next.assets !== this.props.assets ||
      next.drawPage !== this.props.drawPage
    );
  }

  componentDidMount(): void {
    this.draw();
  }

  componentDidUpdate(): void {
    this.draw();
  }

  private draw(): void {
    const { page, designWidth, assets, drawPage } = this.props;
    drawPage(page, designWidth, assets, this.miniature.current!);
  }

  render() {
    const { page, designWidth } = this.props;
    const scale = THUMBNAIL_WIDTH / designWidth;
    return (
      <div
        className="thumbnail"
        style={{ height: `${Math.min(72, page.height * scale)}px` }}
      >
        <div
          className="page"
          ref={this.miniature}
          style={{ transform: `scale(${scale})` }}
        />
      </div>
    );
  }
}

const PageStrip = ({
  editor,
  drawPage,
}: {
  drawPage: PageRenderer;
  editor: StackEditor;
}) => {
  const { project, pageIndex } = editor.state.value;
  return (
    <>
      {project.pages.map((page, index) => (
        <li key={page.id}>
          <button
            aria-current={index === pageIndex ? 'page' : undefined}
            data-page={index}
            draggable
            title={`Show ${page.name}; drag to reorder`}
            type="button"
          >
            <Thumbnail
              assets={project.assets}
              designWidth={project.designWidth}
              drawPage={drawPage}
              page={page}
            />
            <span>{`${index + 1}. ${page.name}`}</span>
          </button>
        </li>
      ))}
    </>
  );
};

/** Navigation and drag events stay delegated to the shell's strip container. */
export const mountPageStrip = (
  container: HTMLElement,
  editor: StackEditor,
  drawPage: PageRenderer,
): (() => void) => {
  render(<PageStrip drawPage={drawPage} editor={editor} />, container);
  return () => render(null, container);
};
