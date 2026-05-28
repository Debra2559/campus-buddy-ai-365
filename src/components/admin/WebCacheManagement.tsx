import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { Globe, RefreshCw, ExternalLink, Loader2, Trash2 } from 'lucide-react';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';

interface WebKnowledgeItem {
  id: string;
  url: string;
  title: string;
  summary: string | null;
  tags: string[];
  source: string;
  last_crawled_at: string;
}

export const WebCacheManagement = () => {
  const [items, setItems] = useState<WebKnowledgeItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [crawling, setCrawling] = useState(false);
  const { toast } = useToast();

  const fetchItems = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('web_knowledge')
      .select('id, url, title, summary, tags, source, last_crawled_at')
      .order('last_crawled_at', { ascending: false })
      .limit(200);

    if (error) {
      toast({ variant: 'destructive', title: '加载失败', description: error.message });
    } else {
      setItems(data || []);
    }
    setLoading(false);
  };

  useEffect(() => { fetchItems(); }, []);

  const handleCrawl = async () => {
    setCrawling(true);
    toast({ title: '正在抓取华农官网...', description: '通常需要 1-3 分钟，请稍候' });

    const { data, error } = await supabase.functions.invoke('crawl-hzau', { body: {} });

    setCrawling(false);
    if (error) {
      toast({ variant: 'destructive', title: '抓取失败', description: error.message });
    } else {
      toast({
        title: '抓取完成',
        description: `共采集 ${data?.crawled ?? 0} 个页面，更新 ${data?.upserted ?? 0} 条`,
      });
      fetchItems();
    }
  };

  const handleDelete = async (id: string) => {
    const { error } = await supabase.from('web_knowledge').delete().eq('id', id);
    if (error) {
      toast({ variant: 'destructive', title: '删除失败', description: error.message });
    } else {
      toast({ title: '已删除' });
      fetchItems();
    }
  };

  const fmtDate = (d: string) => new Date(d).toLocaleString('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  return (
    <Card>
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
              <Globe className="w-5 h-5 text-primary" />
            </div>
            <div>
              <CardTitle className="text-lg">网页缓存</CardTitle>
              <CardDescription className="mt-0.5">
                定期抓取的华中农业大学官网页面（每周自动刷新）
              </CardDescription>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="icon" onClick={fetchItems} disabled={loading}>
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
            <Button onClick={handleCrawl} disabled={crawling} className="gap-2">
              {crawling ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              {crawling ? '抓取中...' : '立即刷新缓存'}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="mb-4 flex items-center gap-4 text-sm text-muted-foreground">
          <span>共 <strong className="text-foreground">{items.length}</strong> 条缓存</span>
          <span>·</span>
          <span>最近更新: {items[0] ? fmtDate(items[0].last_crawled_at) : '无'}</span>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : items.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <Globe className="w-12 h-12 mx-auto mb-4 opacity-50" />
            <p>暂无网页缓存</p>
            <p className="text-sm">点击"立即刷新缓存"开始抓取</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>标题</TableHead>
                <TableHead>标签</TableHead>
                <TableHead>抓取时间</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((it) => (
                <TableRow key={it.id}>
                  <TableCell className="max-w-[400px]">
                    <a href={it.url} target="_blank" rel="noopener noreferrer"
                       className="flex items-center gap-1 hover:text-primary hover:underline">
                      <span className="truncate">{it.title}</span>
                      <ExternalLink className="w-3 h-3 shrink-0" />
                    </a>
                    {it.summary && (
                      <p className="text-xs text-muted-foreground truncate mt-0.5">{it.summary}</p>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {(it.tags || []).slice(0, 2).map(t => (
                        <Badge key={t} variant="secondary" className="text-xs">{t}</Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {fmtDate(it.last_crawled_at)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="icon"
                            onClick={() => handleDelete(it.id)}
                            className="text-destructive hover:text-destructive">
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
};
