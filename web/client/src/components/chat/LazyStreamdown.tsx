import React from 'react';

type LazyStreamdownProps = {
  children?: React.ReactNode;
  components?: Record<string, React.ComponentType<any>>;
};

function renderInline(text: string): React.ReactNode[] {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g);
  return parts.map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={index}>{part.slice(1, -1)}</code>;
    }
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    const link = part.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/);
    if (link) {
      return <a key={index} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>;
    }
    return part;
  });
}

function LightweightMarkdown({ text, components }: { text: string; components?: Record<string, React.ComponentType<any>> }) {
  const CodeComponent = components?.code;
  const blocks = text.split(/(```[\s\S]*?```)/g).filter(Boolean);

  return (
    <>
      {blocks.map((block, blockIndex) => {
        if (block.startsWith('```') && block.endsWith('```')) {
          const raw = block.slice(3, -3).replace(/^\n/, '');
          const firstNewline = raw.indexOf('\n');
          const language = firstNewline > -1 ? raw.slice(0, firstNewline).trim() : '';
          const code = firstNewline > -1 ? raw.slice(firstNewline + 1) : raw;
          if (CodeComponent) {
            return <CodeComponent key={blockIndex} className={language ? `language-${language}` : undefined}>{code}</CodeComponent>;
          }
          return <pre key={blockIndex}><code>{code}</code></pre>;
        }

        return block.split('\n').map((line, lineIndex) => {
          const key = `${blockIndex}-${lineIndex}`;
          if (!line.trim()) return <br key={key} />;
          if (line.startsWith('### ')) return <h3 key={key}>{renderInline(line.slice(4))}</h3>;
          if (line.startsWith('## ')) return <h2 key={key}>{renderInline(line.slice(3))}</h2>;
          if (line.startsWith('# ')) return <h1 key={key}>{renderInline(line.slice(2))}</h1>;
          if (/^[-*] /.test(line)) return <li key={key}>{renderInline(line.slice(2))}</li>;
          return <p key={key}>{renderInline(line)}</p>;
        });
      })}
    </>
  );
}

/**
 * Lightweight local replacement for Streamdown.
 * R99: avoids bundling streamdown → shiki/mermaid into dist assets.
 */
export function LazyStreamdown({ children, components }: LazyStreamdownProps) {
  const text = typeof children === 'string' ? children : String(children ?? '');
  return <LightweightMarkdown text={text} components={components} />;
}

export default LazyStreamdown;
