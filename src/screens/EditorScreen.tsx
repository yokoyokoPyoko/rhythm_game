import { Link } from 'react-router-dom'

export default function EditorScreen() {
  return (
    <div className="editor-screen">
      <header className="editor-header">
        <h1>オーサリングツール</h1>
        <Link to="/">/ に戻る</Link>
      </header>

      <div className="editor-body">
        <aside className="editor-sidebar">
          <section className="editor-pane">
            <h2>音楽制御</h2>
            {/* TODO(T51): オーディオURL入力・再生/停止・現在位置表示 */}
          </section>
          <section className="editor-pane">
            <h2>BPM設定</h2>
            {/* TODO(T54): 基本BPM・BPM変更リスト・タップテンポ */}
          </section>
        </aside>

        <main className="editor-main">
          <div className="editor-timeline">
            {/* TODO(T52/T53): リング録音・セグメントエディタ・タイムライン */}
          </div>
        </main>
      </div>
    </div>
  )
}
