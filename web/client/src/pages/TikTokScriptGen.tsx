import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Loader2, Sparkles, Copy, Check, Film, Clock, Hash, Target } from 'lucide-react';
import { toast } from 'sonner';
import { getAuthToken } from '@/lib/api';


function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = getAuthToken();
  const headers: Record<string, string> = { ...extra };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

const API_BASE = '';  // Use relative path for same-origin requests

interface Script {
  style: string;
  duration: string;
  hook: string;
  content: string;
  tags: string[];
}

interface GenerateResult {
  success: boolean;
  game: string;
  country: string;
  tone: string;
  duration: number;
  data: Script[];
}

const GAMES = [
  '绝区零', '原神', 'MLBB', 'Free Fire', 'PUBG Mobile', 
  'Honkai Star Rail', 'Genshin Impact', 'Zenless Zone Zero',
  'Arena of Valor', 'Call of Duty Mobile'
];

const COUNTRIES = [
  { code: 'US', name: '美国', flag: '🇺🇸' },
  { code: 'ID', name: '印尼', flag: '🇮🇩' },
  { code: 'BR', name: '巴西', flag: '🇧🇷' },
  { code: 'TH', name: '泰国', flag: '🇹🇭' },
  { code: 'VN', name: '越南', flag: '🇻🇳' },
  { code: 'PH', name: '菲律宾', flag: '🇵🇭' },
  { code: 'MY', name: '马来西亚', flag: '🇲🇾' },
  { code: 'MX', name: '墨西哥', flag: '🇲🇽' },
];

const TONES = [
  { value: '幽默悬念', label: 'Hook-First (悬念开头)' },
  { value: '测评种草', label: 'Review (测评种草)' },
  { value: '故事叙述', label: 'Story (故事型)' },
  { value: '紧迫感', label: 'Urgency (限时紧迫)' },
];

export default function TikTokScriptGen() {
  const { t } = useI18n();
  const [game, setGame] = useState('');
  const [customGame, setCustomGame] = useState('');
  const [country, setCountry] = useState('');
  const [tone, setTone] = useState('幽默悬念');
  const [duration, setDuration] = useState('30');
  const [target, setTarget] = useState('推广游戏充值服务');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [history, setHistory] = useState<{ game: string; country: string; tone: string; time: string; count: number }[]>([]);

  const handleGenerate = async () => {
    const finalGame = game === 'custom' ? customGame : game;
    if (!finalGame || !country) {
      setError('请选择游戏和目标国家');
      return;
    }
    setError('');
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/tiktok/generate-script`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ 
          game: finalGame, 
          country, 
          tone, 
          duration: parseInt(duration),
          target 
        }),
      });
      const data = await res.json();
      if (data.success) {
        setResult(data);
        setHistory(prev => [{ game: data.game, country: data.country, tone: data.tone, time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }), count: data.data?.length || 0 }, ...prev].slice(0, 10));
      } else {
        setError(data.error || '生成失败');
      }
    } catch (err) {
      setError('网络错误，请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  const copyScript = (script: Script, idx: number) => {
    const text = `【${script.style}】\n\nHook: ${script.hook}\n\n${script.content}\n\nTags: ${script.tags.join(' ')}`;
    navigator.clipboard.writeText(text);
    setCopiedIdx(idx);
    setTimeout(() => setCopiedIdx(null), 2000);
  };

  const styleColors: Record<string, string> = {
    'Hook-First': 'bg-red-500/20 text-red-400 border-red-500/30',
    'Review': 'bg-blue-500/20 text-blue-400 border-blue-500/30',
    'Story': 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  };

  const getStyleColor = (style: string) => {
    for (const [key, val] of Object.entries(styleColors)) {
      if (style.includes(key)) return val;
    }
    return 'bg-gray-500/20 text-gray-400 border-gray-500/30';
  };

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-white p-6">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-pink-500 to-violet-600 flex items-center justify-center">
              <Film className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-bold bg-gradient-to-r from-pink-400 to-violet-400 bg-clip-text text-transparent">
                TikTok 文案引擎
              </h1>
              <p className="text-sm text-gray-400">AI 驱动的短视频带货脚本生成器</p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left: Input Form */}
          <Card className="bg-[#12121a] border-[#1e1e2e] lg:col-span-1">
            <CardHeader>
              <CardTitle className="text-white text-lg">脚本参数</CardTitle>
              <CardDescription className="text-gray-400">配置文案生成参数</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Game Select */}
              <div className="space-y-2">
                <label className="text-sm text-gray-300 flex items-center gap-1.5">
                  <Target className="w-3.5 h-3.5" /> 游戏名称
                </label>
                <Select value={game} onValueChange={setGame}>
                  <SelectTrigger className="bg-[#1a1a2e] border-[#2a2a3e] text-white">
                    <SelectValue placeholder="选择游戏" />
                  </SelectTrigger>
                  <SelectContent className="bg-[#1a1a2e] border-[#2a2a3e]">
                    {GAMES.map(g => (
                      <SelectItem key={g} value={g} className="text-white hover:bg-[#2a2a3e]">{g}</SelectItem>
                    ))}
                    <SelectItem value="custom" className="text-white hover:bg-[#2a2a3e]">自定义...</SelectItem>
                  </SelectContent>
                </Select>
                {game === 'custom' && (
                  <Input 
                    placeholder="输入游戏名称" 
                    value={customGame}
                    onChange={e => setCustomGame(e.target.value)}
                    className="bg-[#1a1a2e] border-[#2a2a3e] text-white"
                  />
                )}
              </div>

              {/* Country Select */}
              <div className="space-y-2">
                <label className="text-sm text-gray-300">目标市场</label>
                <Select value={country} onValueChange={setCountry}>
                  <SelectTrigger className="bg-[#1a1a2e] border-[#2a2a3e] text-white">
                    <SelectValue placeholder="选择国家/地区" />
                  </SelectTrigger>
                  <SelectContent className="bg-[#1a1a2e] border-[#2a2a3e]">
                    {COUNTRIES.map(c => (
                      <SelectItem key={c.code} value={c.code} className="text-white hover:bg-[#2a2a3e]">
                        {c.flag} {c.name} ({c.code})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Tone Select */}
              <div className="space-y-2">
                <label className="text-sm text-gray-300">文案风格</label>
                <Select value={tone} onValueChange={setTone}>
                  <SelectTrigger className="bg-[#1a1a2e] border-[#2a2a3e] text-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-[#1a1a2e] border-[#2a2a3e]">
                    {TONES.map(t => (
                      <SelectItem key={t.value} value={t.value} className="text-white hover:bg-[#2a2a3e]">{t.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Duration */}
              <div className="space-y-2">
                <label className="text-sm text-gray-300 flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5" /> 视频时长
                </label>
                <Select value={duration} onValueChange={setDuration}>
                  <SelectTrigger className="bg-[#1a1a2e] border-[#2a2a3e] text-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-[#1a1a2e] border-[#2a2a3e]">
                    <SelectItem value="15" className="text-white hover:bg-[#2a2a3e]">15 秒</SelectItem>
                    <SelectItem value="30" className="text-white hover:bg-[#2a2a3e]">30 秒</SelectItem>
                    <SelectItem value="60" className="text-white hover:bg-[#2a2a3e]">60 秒</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Platform */}
              <div className="space-y-2">
                <label className="text-sm text-gray-300 flex items-center gap-1.5">
                  <Film className="w-3.5 h-3.5" /> {'目标平台'}
                </label>
                <div className="grid grid-cols-3 gap-1.5">
                  {[
                    { key: 'tiktok', label: 'TikTok', emoji: '\u{1F3B5}' },
                    { key: 'youtube', label: 'YT Shorts', emoji: '\u{1F534}' },
                    { key: 'instagram', label: 'IG Reels', emoji: '\u{1F4F7}' },
                  ].map(p => (
                    <button
                      key={p.key}
                      className={`text-[10px] py-1.5 rounded-md transition ${
                        p.key === 'tiktok'
                          ? 'bg-pink-500/20 text-pink-400 border border-pink-500/30'
                          : 'bg-[#1a1a2e] text-gray-500 border border-[#2a2a3e] hover:text-gray-300'
                      }`}
                      onClick={() => p.key !== 'tiktok' && toast.info(`${p.label} 模式即将上线`)}
                    >
                      {p.emoji} {p.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Target */}
              <div className="space-y-2">
                <label className="text-sm text-gray-300">推广目标</label>
                <Input 
                  placeholder="例：推广游戏充值服务" 
                  value={target}
                  onChange={e => setTarget(e.target.value)}
                  className="bg-[#1a1a2e] border-[#2a2a3e] text-white"
                />
              </div>

              {error && (
                <p className="text-sm text-red-400">{error}</p>
              )}

              <Button 
                onClick={handleGenerate} 
                disabled={loading}
                className="w-full bg-gradient-to-r from-pink-500 to-violet-600 hover:from-pink-600 hover:to-violet-700 text-white"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    生成中...
                  </>
                ) : (
                  <>
                    <Sparkles className="w-4 h-4 mr-2" />
                    生成文案
                  </>
                )}
              </Button>
            </CardContent>
          </Card>

          {/* Right: Results */}
          <div className="lg:col-span-2 space-y-4">
            {!result && !loading && (
              <Card className="bg-[#12121a] border-[#1e1e2e] h-full flex items-center justify-center">
                <CardContent className="text-center py-20">
                  <Film className="w-16 h-16 text-gray-600 mx-auto mb-4" />
                  <p className="text-gray-400 text-lg">选择参数后点击「生成文案」</p>
                  <p className="text-gray-500 text-sm mt-2">AI 将为你生成 3 种不同风格的 TikTok 脚本</p>
                </CardContent>
              </Card>
            )}

            {loading && (
              <Card className="bg-[#12121a] border-[#1e1e2e] h-full flex items-center justify-center">
                <CardContent className="text-center py-20">
                  <Loader2 className="w-12 h-12 text-violet-400 mx-auto mb-4 animate-spin" />
                  <p className="text-gray-300 text-lg">正在生成文案...</p>
                  <p className="text-gray-500 text-sm mt-2">AI 正在为 {game === 'custom' ? customGame : game} 创作脚本</p>
                </CardContent>
              </Card>
            )}

            {result && !loading && (
              <>
                {/* Result Header */}
                <div className="flex items-center gap-3 mb-2">
                  <Badge className="bg-green-500/20 text-green-400 border-green-500/30">
                    生成成功
                  </Badge>
                  <span className="text-sm text-gray-400">
                    {result.game} · {result.country} · {result.tone} · {result.duration}s
                  </span>
                </div>

                {/* Script Cards */}
                {result.data.map((script, idx) => (
                  <Card key={idx} className="bg-[#12121a] border-[#1e1e2e] hover:border-[#2e2e4e] transition-colors">
                    <CardHeader className="pb-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Badge className={getStyleColor(script.style)}>
                            {script.style}
                          </Badge>
                          <Badge variant="outline" className="border-[#2a2a3e] text-gray-400">
                            {script.duration}
                          </Badge>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => copyScript(script, idx)}
                          className="text-gray-400 hover:text-white"
                        >
                          {copiedIdx === idx ? (
                            <><Check className="w-4 h-4 mr-1 text-green-400" /> 已复制</>
                          ) : (
                            <><Copy className="w-4 h-4 mr-1" /> 复制</>
                          )}
                        </Button>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {/* Hook */}
                      <div className="bg-[#1a1a2e] rounded-lg p-3 border border-[#2a2a3e]">
                        <p className="text-xs text-gray-500 mb-1">HOOK (开头 3 秒)</p>
                        <p className="text-white font-medium">{script.hook}</p>
                      </div>

                      {/* Content */}
                      <div className="bg-[#0d0d15] rounded-lg p-3 border border-[#1e1e2e]">
                        <p className="text-xs text-gray-500 mb-2">完整脚本</p>
                        <pre className="text-sm text-gray-300 whitespace-pre-wrap font-sans leading-relaxed">
                          {script.content}
                        </pre>
                      </div>

                      {/* Tags */}
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <Hash className="w-3.5 h-3.5 text-gray-500" />
                        {script.tags.map((tag, i) => (
                          <span key={i} className="text-xs text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded-full">
                            {tag}
                          </span>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </>
            )}
          </div>
        </div>
        {/* Generation History */}
        {history.length > 0 && (
          <div className="mt-6">
            <h3 className="text-sm font-medium text-gray-400 mb-3 flex items-center gap-2">
              <Clock className="w-4 h-4" />
              {'生成历史'}
              <span className="text-[10px] bg-zinc-800 text-zinc-500 px-1.5 py-0.5 rounded">{history.length}</span>
            </h3>
            <div className="space-y-2">
              {history.map((h, i) => (
                <div key={i} className="flex items-center justify-between bg-[#12121a] border border-[#1e1e2e] rounded-lg px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-300">{h.game}</span>
                    <span className="text-[10px] text-gray-500">{h.country}</span>
                    <Badge variant="outline" className="text-[10px] border-[#2a2a3e] text-gray-500">{h.tone}</Badge>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-gray-500">{h.count} {'篇'}</span>
                    <span className="text-[10px] text-gray-600">{h.time}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Template Quick Start */}
        <div className="mt-6">
          <h3 className="text-sm font-medium text-gray-400 mb-3 flex items-center gap-2">
            <Target className="w-4 h-4" />
            {'快速模板'}
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {[
              { name: '爆款游戏推广', game: '原神', country: 'US', tone: '幽默悬念', desc: '适合美区游戏充值推广' },
              { name: '东南亚市场', game: 'MLBB', country: 'ID', tone: '紧迫感', desc: '印尼市圻MLBB钻石促销' },
              { name: '测评种草', game: '绝区零', country: 'US', tone: '测评种草', desc: '新游测评引导充值' },
            ].map((tpl, i) => (
              <button
                key={i}
                onClick={() => { setGame(tpl.game); setCountry(tpl.country); setTone(tpl.tone); }}
                className="text-left bg-[#12121a] border border-[#1e1e2e] hover:border-violet-500/30 rounded-lg p-3 transition-colors"
              >
                <p className="text-sm font-medium text-gray-200">{tpl.name}</p>
                <p className="text-[10px] text-gray-500 mt-1">{tpl.desc}</p>
                <div className="flex items-center gap-1.5 mt-2">
                  <span className="text-[10px] bg-pink-500/10 text-pink-400 px-1.5 py-0.5 rounded">{tpl.game}</span>
                  <span className="text-[10px] bg-violet-500/10 text-violet-400 px-1.5 py-0.5 rounded">{tpl.country}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
