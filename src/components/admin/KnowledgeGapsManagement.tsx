import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { AlertTriangle, RefreshCw, CheckCircle2, Loader2, Trash2 } from 'lucide-react';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';

interface Gap {
  id: string;
  user_query: string;
  normalized_query: string;
  occurrences: number;
  status: string;
  reason: string | null;
  last_seen_at: string;
  suggested_topic: string | null;
}

export const KnowledgeGapsManagement = () => {
  const [gaps, setGaps] = useState<Gap[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'pending' | 'resolved' | 'all'>('pending');
  const { toast } = useToast();

  const fetchGaps = async () => {
    setLoading(true);
    let q = supabase
      .from('knowledge_gaps')
      .select('*')
      .order('occurrences', { ascending: false })
      .order('last_seen_at', { ascending: false })
      .limit(200);

    if (filter !== 'all') q = q.eq('status', filter);

    const { data, error } = await q;
    if (error) {
      toast({ variant: 'destructive', title: '加载失败', description: error.message });
    } else {
      setGaps(data || []);
    }
    setLoading(false);
  };

  useEffect(() => { fetchGaps(); }, [filter]);

  const markResolved = async (id: string) => {
    const { error } = await supabase
      .from('knowledge_gaps')
      .update({ status: 'resolved', resolved_at: new Date().toISOString() })
      .eq('id', id);
    if (error) {
      toast({ variant: 'destructive', title: '操作失败', description: error.message });
    } else {
      toast({ title: '已标记为已解决' });
      fetchGaps();
    }
  };

  const deleteGap = async (id: string) => {
    const { error } = await supabase.from('knowledge_gaps').delete().eq('id', id);
    if (error) {
      toast({ variant: 'destructive', title: '删除失败', description: error.message });
    } else {
      fetchGaps();
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
            <div className="w-10 h-10 rounded-xl bg-amber-500/10 flex items-center justify-center">
              <AlertTriangle className="w-5 h-5 text-amber-500" />
            </div>
            <div>
              <CardTitle className="text-lg">知识盲点</CardTitle>
              <CardDescription className="mt-0.5">
                AI 无法回答的问题，按出现频次排序——这些是知识库需要补充的方向
              </CardDescription>
            </div>
          </div>
          <div className="flex gap-2">
            <div className="flex rounded-md border border-border overflow-hidden">
              {(['pending', 'resolved', 'all'] as const).map(f => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`px-3 py-1.5 text-xs ${
                    filter === f ? 'bg-primary text-primary-foreground' : 'bg-background hover:bg-muted'
                  }`}
                >
                  {f === 'pending' ? '待处理' : f === 'resolved' ? '已解决' : '全部'}
                </button>
              ))}
            </div>
            <Button variant="outline" size="icon" onClick={fetchGaps} disabled={loading}>
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : gaps.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <CheckCircle2 className="w-12 h-12 mx-auto mb-4 opacity-50 text-green-500" />
            <p>暂无知识盲点</p>
            <p className="text-sm">AI 当前能很好地回答用户问题</p>
          </div>
        ) : (
          <>
            <div className="mb-4 p-3 bg-amber-500/5 border border-amber-500/20 rounded-lg text-sm text-muted-foreground">
              💡 建议针对出现次数 ≥ 3 的高频问题，上传相关的政策文档、通知或 FAQ 到知识库
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>用户问题</TableHead>
                  <TableHead className="w-20 text-center">次数</TableHead>
                  <TableHead className="w-24">状态</TableHead>
                  <TableHead className="w-32">最近</TableHead>
                  <TableHead className="text-right w-32">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {gaps.map((g) => (
                  <TableRow key={g.id}>
                    <TableCell className="max-w-[500px]">
                      <p className="truncate">{g.user_query}</p>
                      {g.reason && (
                        <p className="text-xs text-muted-foreground mt-0.5">原因: {g.reason}</p>
                      )}
                    </TableCell>
                    <TableCell className="text-center">
                      <Badge variant={g.occurrences >= 3 ? 'destructive' : 'secondary'}>
                        {g.occurrences}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {g.status === 'resolved' ? (
                        <Badge variant="default" className="bg-green-500">已解决</Badge>
                      ) : (
                        <Badge variant="outline">待处理</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                      {fmtDate(g.last_seen_at)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        {g.status !== 'resolved' && (
                          <Button variant="ghost" size="sm" onClick={() => markResolved(g.id)}>
                            标记解决
                          </Button>
                        )}
                        <Button variant="ghost" size="icon"
                                onClick={() => deleteGap(g.id)}
                                className="text-destructive hover:text-destructive">
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </CardContent>
    </Card>
  );
};
