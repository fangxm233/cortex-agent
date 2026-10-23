// Machine list / probe words (mobile Machines screen and the shared machine-detail view-model).
export const machinesEn = {
  machOnline: 'Online',
  machOffline: 'Offline',
  machHeartbeat: 'HB',
  machLastHeartbeat: 'last HB',
  machDaemon: 'daemon',
  machAdd: 'Add machine',
  machEmpty: 'No machines',
  machRam: 'RAM',
  machDisk: 'Disk',
  machDiskFree: '{n} GB free',
};
export const machinesZh: Record<keyof typeof machinesEn, string> = {
  machOnline: '在线',
  machOffline: '离线',
  machHeartbeat: '心跳',
  machLastHeartbeat: '上次心跳',
  machDaemon: 'daemon',
  machAdd: '添加机器',
  machEmpty: '暂无机器',
  machRam: '内存',
  machDisk: '磁盘',
  machDiskFree: '剩余 {n} GB',
};
