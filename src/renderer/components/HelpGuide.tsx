import { HELP_FOOTER, HELP_SECTIONS, HELP_STEPS } from '../study/guide'

 /**
  * 第一次打开时的「怎么用」。
  * 只讲“先做什么、每个入口管什么”，不把内部术语再搬给用户。
  */
export function HelpGuide({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop help-backdrop" role="dialog" aria-modal="true" aria-labelledby="help-guide-title" onClick={onClose}>
      <div className="modal help-guide" onClick={(event) => event.stopPropagation()}>
        <header>
          <div>
            <h2 id="help-guide-title">灯下怎么用</h2>
            <p className="quiet">1 分钟看完。忘了也没关系，右上角一直有「怎么用」。</p>
          </div>
          <button className="ghost" onClick={onClose}>知道了</button>
        </header>

        <div className="help-steps" aria-label="上手三步">
          {HELP_STEPS.map((step, index) => (
            <div className="help-step" key={step.title}>
              <span>{index + 1}</span>
              <b>{step.title}</b>
              <p>{step.body}</p>
            </div>
          ))}
        </div>

        <div className="help-sections">
          {HELP_SECTIONS.map((section) => (
            <section className="help-section" key={section.title}>
              <h3>{section.title}</h3>
              <p>{section.body}</p>
              <ul>
                {section.items.map((item) => <li key={item}>{item}</li>)}
              </ul>
            </section>
          ))}
        </div>

        <p className="help-foot">{HELP_FOOTER}</p>
        <div className="row help-actions">
          <button className="primary" onClick={onClose}>开始用</button>
        </div>
      </div>
    </div>
  )
}
