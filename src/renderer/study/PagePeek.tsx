import type { PageView } from '../../shared/contract'
import type { StudySlideCitation } from '../../shared/study'
import { bboxStyle } from './evidence'

/** 整页预览：课堂消息、总结/题测、复习页共用，不裁剪页图。 */
export function PagePeek({
  citation,
  page,
  onClose,
}: {
  citation: StudySlideCitation
  page: PageView | null
  onClose: () => void
}) {
  return (
    <div className="modal-backdrop ws-peek-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="modal ws-peek">
        <header>
          <div>
            <h2>对照讲义 p.{citation.pageNumber}</h2>
            <p className="quiet">
              {citation.bbox
                ? '整页原图，不裁剪；黄色框是老师刚才引用的位置。'
                : '定位到页：整页原图，不裁剪；这一句未能逐字对上，所以不画框。'}
            </p>
          </div>
          <button className="icon-btn" title="关闭" onClick={onClose}>×</button>
        </header>
        <div className="ws-peek-body">
          {page?.previewResourceId ? (
            <div className="ws-peek-image">
              <img src={`app-resource://${page.previewResourceId}`} alt={`第 ${citation.pageNumber} 页`} />
              {citation.bbox ? <span className="ws-cite-box" style={bboxStyle(citation.bbox)} /> : null}
            </div>
          ) : (
            <div className="ws-peek-noimg">这一页没有页面图，下面保留原句。</div>
          )}
          <blockquote>{citation.quote}</blockquote>
        </div>
      </div>
    </div>
  )
}
