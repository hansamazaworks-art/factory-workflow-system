// Single source of truth for how each job_orders.status value is
// displayed. Every module (production, maintenance, toolroom,
// purchasing, management) should import this instead of redefining it.
module.exports = {
  pending: 'Waiting for Maintenance',
  accepted: 'Accepted by Maintenance',
  tool_requested: 'Tools/Materials Requested',
  checking_stock: 'Toolroom Checking Stock',
  ready_to_issue: 'Ready to Issue',
  issued: 'Tools Issued',
  awaiting_purchase: 'Waiting on Purchase Order',
  in_progress: 'Work In Progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
  // These next few are only ever written to job_order_status_log
  // (a free-text column), never to job_orders.status itself - they
  // exist so the timeline reads clearly once Purchasing/Management
  // get involved.
  po_created: 'Purchase Order Created',
  po_approved: 'Purchase Order Approved',
  po_rejected: 'Purchase Order Rejected',
  ordered: 'Purchase Order Placed with Supplier',
  received: 'Purchase Order Received'
};
