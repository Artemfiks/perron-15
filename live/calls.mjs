export const aircraft = ['SSJ100','A320','A321','B737-800'];
export const defects = {
  ENG: ['Утечка масла силовой установки','ATA 79'],
  SKIN: ['Повреждение обшивки фюзеляжа','ATA 53'],
  HYD: ['Падение давления гидросистемы','ATA 29'],
  GEAR: ['Отказ индикации положения шасси','ATA 32'],
  NAV: ['Отказ навигационного оборудования','ATA 34'],
  RAD: ['Отказ УКВ-радиосвязи','ATA 23'],
  ELE: ['Отказ электропитания салона','ATA 24'],
  LGT: ['Отказ внешнего светотехнического оборудования','ATA 33']
};
export const priorities = {A:'A — борт под вылет',B:'B — транзит / стоянка'};
export function describe(call){
  if(!call.aircraft)return 'Зона '+call.zone;
  return ['№ '+call.number,call.aircraft,call.tail,'зона '+call.zone,defects[call.defect].join(' · '),priorities[call.priority]].filter(Boolean).join(' · ');
}
